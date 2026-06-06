// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare

(() => {

    // kubejs/server_scripts/SuperbDrivingAssistance.js
    const DEBUG_DRIVING = true;
    const DEBUG_EVERY_TICKS = 5;

    const REVERSE_ALIGN_MAX_TICKS = 64;
    const REVERSE_ALIGN_COOLDOWN_TICKS = 18;

    const CREEP_FORWARD_TICKS = 6;
    const CREEP_FORWARD_COOLDOWN_TICKS = 8;

    // Matches VehicleEffectUtils.lowHealthWarning:
    // smoke starts at vehicle.health <= 0.4 * vehicle.getMaxHealth()
    // only when vehicle.data().compute().hasLowHealthWarning is true.
    const SMOKE_HEALTH_RATIO = 0.40;

    // If attacker is in front-ish, reverse away.
    // If attacker is behind-ish, drive forward away.
    const PANIC_FORWARD_ANGLE = 70;

    // vCollide probe tuning.
    // This is not ray distance anymore. This is "try moving the actual OBB body this far."
    const MOVE_PROBE_DISTANCE_MIN = 1.25;
    const MOVE_PROBE_DISTANCE_MAX = 5.0;
    const MOVE_PROBE_LENGTH_MULTIPLIER = 0.65;

    // If Superb Warfare allows less than this much of the requested movement,
    // treat the path as blocked.
    const MOVE_BLOCKED_RATIO = 0.55;

    // Used when choosing left vs right.
    // Prevents tiny score differences from constantly flipping steering.
    const AVOID_SCORE_MARGIN = 0.10;

    const OBSTACLE_REVERSE_MIN_TICKS = 12;
    const OBSTACLE_REVERSE_MAX_TICKS = 40;
    const OBSTACLE_REVERSE_TICKS_PER_BLOCK = 5;

    const { $UUID } = require("@package/java/util");
    const { $Player } = require("@package/net/minecraft/world/entity/player");
    const { $PlayerInteractEvent$EntityInteract } = require("@package/net/neoforged/neoforge/event/entity/player");
    const { $EntityTickEvent$Pre } = require("@package/net/neoforged/neoforge/event/tick");
    const { $VehicleEntity } = require("@package/com/atsuishio/superbwarfare/entity/vehicle/base");
    const { $VehicleVecUtils, $VehicleMotionUtils } = require("@package/com/atsuishio/superbwarfare/entity/vehicle/utils");
    const { $Monster } = require("@package/net/minecraft/world/entity/monster");
    const { $LivingEntity } = require("@package/net/minecraft/world/entity");
    const { $Mth } = require("@package/net/minecraft/util");
    const { $Vec3 } = require("@package/net/minecraft/world/phys");


    NativeEvents.onEvent($PlayerInteractEvent$EntityInteract, (event) => {

        const player = event.getEntity();
        if (player instanceof $Player) {

            if (player.level.isClientSide()) return;

            const lead = player.getMainHandItem().copy();
            if (lead && lead.getIdLocation() === Item.of("minecraft:lead").getIdLocation()) {

                const target = event.getTarget();
                if (target instanceof $VehicleEntity) {

                    player.level.runCommand(`superbwarfare ride ${lead.getCustomData().getString("sbw_vehicle_rider")} ${target.getUuid()}`)
                } else if (target instanceof $LivingEntity) {

                    lead.setCustomData({
                        "sbw_vehicle_rider": target.getStringUuid()
                    })
                    player.setMainHandItem(lead)
                    player.tell("Vehicle Rider: " + target.getStringUuid())
                }
            }
        }
    })


    NativeEvents.onEvent($EntityTickEvent$Pre, (event) => {

        const driver = event.getEntity();

        if (!(driver instanceof $LivingEntity)) return;
        if (driver.isPlayer()) return;
        if (driver.level.isClientSide()) return;

        const vehicle = driver.getVehicle();

        if (vehicle == null) return;
        if (!(vehicle instanceof $VehicleEntity)) return;
        if (vehicle.getFirstPassenger() != driver) return;

        vehicle.getPersistentData().putBoolean("sbw_ai_is_hostile", (driver instanceof $Monster));

        stopVehicle(vehicle, driver);
        moveVehicle(vehicle, driver);
    });


    function moveVehicle(vehicle, driver) {
        const followRange = driver.getAttributeValue("minecraft:generic.follow_range");

        // Safety system runs first.
        // This does not care whether the mob driver has a normal target.
        if (tryPanicEscape(vehicle, driver, followRange)) {
            return;
        }

        const target = driver.getTarget ? driver.getTarget() : null;
        if (!(target instanceof $LivingEntity)) return;

        updateRecoveryCooldown(vehicle);
        updateDrivingTimers(vehicle);

        const diff = getDiffToPosition(vehicle, target.position());
        const absDiff = Math.abs(diff);

        steerTowardDiff(vehicle, diff, absDiff);

        const distance = vehicle.distanceToEntity(target);

        assistedDrive(vehicle, distance, followRange, diff, absDiff);
    }


    /**
     * Panic escape.
     * @param {$VehicleEntity} vehicle 
     * @param {$LivingEntity} driver 
     * @param {Number} followRange
     */
    function tryPanicEscape(vehicle, driver, followRange) {
        const healthRatio = getVehicleHealthRatio(vehicle);
        const warning = vehicleHasLowHealthWarning(vehicle);
        const attackerUuid = getVehicleLastAttackerUuid(vehicle);

        debugDriving(
            vehicle,
            `panicCheck hp=${healthRatio.toFixed(2)} smoke=${SMOKE_HEALTH_RATIO.toFixed(2)} warning=${warning} uuid=${attackerUuid}`
        );

        if (!warning) return false;
        if (healthRatio > SMOKE_HEALTH_RATIO) return false;
        if (attackerUuid == "") return false;

        const attacker = getLastAttackerEntity(vehicle);

        // Last Attacker cannot equal a passanger of the vehicle.
        // Last Attacker cannot be within the vehicles bounding.
        if (!(attacker instanceof $LivingEntity) || vehicle.isPassengerOfSameVehicle(attacker) || attacker == vehicle) {
            debugDriving(
                vehicle,
                `panicFail uuidFoundButEntityMissing uuid=${attackerUuid}`
            );

            return false;
        }

        const panicDistance = vehicle.distanceToEntity(attacker);

        if (panicDistance > followRange) {
            debugDriving(
                vehicle,
                `PANIC escaped dist=${panicDistance.toFixed(1)}/${followRange.toFixed(1)}`
            );

            holdVehicle(vehicle);
            return true;
        }

        assistedPanicDrive(vehicle, attacker, panicDistance, followRange);
        return true;
    }


    function assistedPanicDrive(vehicle, attacker, distance, followRange) {
        updateDrivingTimers(vehicle);

        const healthRatio = getVehicleHealthRatio(vehicle);
        const diffToAttacker = getDiffToPosition(vehicle, attacker.position());
        const absDiffToAttacker = Math.abs(diffToAttacker);

        const speed = getHorizontalSpeed(vehicle);

        // If attacker is in front-ish, reverse away.
        if (absDiffToAttacker < 100) {
            const backProbe = getBackMoveProbe(vehicle);

            debugDriving(
                vehicle,
                `PANIC reverse hp=${healthRatio.toFixed(2)} dist=${distance.toFixed(1)}/${followRange.toFixed(1)} attacker=${attacker.getName().getString()} diff=${diffToAttacker.toFixed(1)} backFit=${backProbe.ratio.toFixed(2)} speed=${speed.toFixed(2)}`
            );

            if (backProbe.blocked) {
                // Backing up would collide. Do not ram backward forever.
                // Pick the better forward diagonal and rotate.
                const leftProbe = getFrontLeftMoveProbe(vehicle);
                const rightProbe = getFrontRightMoveProbe(vehicle);

                chooseAvoidTurnDirectionFromProbes(vehicle, leftProbe, rightProbe);

                holdVehicle(vehicle);
                applyAvoidTurn(vehicle);

                updateStuckTicks(vehicle, false);
                return false;
            }

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

            applyReverseAwayFromTarget(vehicle, diffToAttacker);

            updateStuckTicks(vehicle, true);
            return true;
        }

        // Attacker is behind-ish, so drive forward away.
        const awayPos = getAwayPositionFromEntity(vehicle, attacker);
        const diffAway = getDiffToPosition(vehicle, awayPos);
        const absDiffAway = Math.abs(diffAway);

        steerTowardDiff(vehicle, diffAway, absDiffAway);

        const frontProbe = getFrontMoveProbe(vehicle);
        const frontBlockedTicks = updateFrontBlockedTicks(vehicle, frontProbe.blocked);

        debugDriving(
            vehicle,
            `PANIC forward hp=${healthRatio.toFixed(2)} dist=${distance.toFixed(1)}/${followRange.toFixed(1)} attacker=${attacker.getName().getString()} awayDiff=${diffAway.toFixed(1)} frontFit=${frontProbe.ratio.toFixed(2)} speed=${speed.toFixed(2)}`
        );

        if (frontProbe.blocked) {
            return handleBlockedForward(vehicle, frontBlockedTicks);
        }

        if (absDiffAway < PANIC_FORWARD_ANGLE) {
            vehicle.setForwardInputDown(true);
            vehicle.setBackInputDown(false);

            const stuckTicks = updateStuckTicks(vehicle, true);

            if (stuckTicks >= 10) {
                startObstacleReverse(vehicle);
                return false;
            }

            return true;
        }

        assistedCreepForward(vehicle);
        updateStuckTicks(vehicle, true);
        return true;
    }


    function assistedDrive(vehicle, distance, followRange, diff, absDiff) {
        const data = vehicle.getPersistentData();

        let reverseTicks = data.getInt("sbw_ai_reverse_ticks");
        let reverseAlignTicks = data.getInt("sbw_ai_reverse_align_ticks");

        const frontProbe = getFrontMoveProbe(vehicle);
        const speed = getHorizontalSpeed(vehicle);
        const driveState = getDriveAlignmentState(absDiff);

        debugDriving(
            vehicle,
            `state=${driveState} diff=${diff.toFixed(1)} frontFit=${frontProbe.ratio.toFixed(2)} speed=${speed.toFixed(2)} reverse=${reverseTicks} align=${reverseAlignTicks} alignCd=${data.getInt("sbw_ai_reverse_align_cooldown")} creep=${data.getInt("sbw_ai_creep_forward_ticks")} stuck=${data.getInt("sbw_ai_stuck_ticks")}`
        );

        // Active reverse-align maneuver.
        // This is limited and cannot run forever.
        if (reverseAlignTicks > 0) {
            data.putInt("sbw_ai_reverse_align_ticks", reverseAlignTicks - 1);

            if (absDiff < 45) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                updateStuckTicks(vehicle, false);
                return false;
            }

            if (distance > followRange * 0.6) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                updateStuckTicks(vehicle, false);
                return false;
            }

            const backProbe = getBackMoveProbe(vehicle);

            if (backProbe.blocked) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                updateStuckTicks(vehicle, false);
                return false;
            }

            applyReverseAlign(vehicle, diff);

            updateStuckTicks(vehicle, true);
            return true;
        }

        // If target is getting too far away, cancel obstacle recovery reverse.
        if (distance > followRange * 0.6) {
            reverseTicks = 0;
            data.putInt("sbw_ai_reverse_ticks", 0);
            data.putInt("sbw_ai_stuck_ticks", 0);
        }

        // Obstacle recovery reverse.
        if (reverseTicks > 0) {
            data.putInt("sbw_ai_reverse_ticks", reverseTicks - 1);

            const backProbe = getBackMoveProbe(vehicle);

            if (backProbe.blocked) {
                data.putInt("sbw_ai_reverse_ticks", 0);
                holdVehicle(vehicle);
                applyAvoidTurn(vehicle);
                updateStuckTicks(vehicle, false);
                return false;
            }

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

            applyAvoidTurn(vehicle);

            updateStuckTicks(vehicle, true);
            return true;
        }

        const frontBlockedTicks = updateFrontBlockedTicks(vehicle, frontProbe.blocked);

        if (frontProbe.blocked) {
            return handleBlockedForward(vehicle, frontBlockedTicks);
        }

        if (driveState == "REVERSE_ALIGN") {
            if (canStartReverseAlign(vehicle)) {
                startReverseAlign(vehicle);
                applyReverseAlign(vehicle, diff);

                updateStuckTicks(vehicle, true);
                return true;
            }

            holdVehicle(vehicle);
            updateStuckTicks(vehicle, false);
            return false;
        }

        if (driveState == "TURN_ONLY") {
            assistedCreepForward(vehicle);

            updateStuckTicks(vehicle, true);
            return true;
        }

        // FORWARD
        vehicle.setForwardInputDown(true);
        vehicle.setBackInputDown(false);

        const stuckTicks = updateStuckTicks(vehicle, true);

        if (stuckTicks >= 10) {
            startObstacleReverse(vehicle);
            return false;
        }

        return true;
    }


    function handleBlockedForward(vehicle, frontBlockedTicks) {
        const leftProbe = getFrontLeftMoveProbe(vehicle);
        const rightProbe = getFrontRightMoveProbe(vehicle);

        const turnDirection = chooseAvoidTurnDirectionFromProbes(vehicle, leftProbe, rightProbe);

        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(false);

        if (turnDirection > 0) {
            assistedRight(vehicle);
        } else {
            assistedLeft(vehicle);
        }

        if (frontBlockedTicks >= 10) {
            vehicle.getPersistentData().putInt("sbw_ai_front_blocked_ticks", 0);

            startObstacleReverse(vehicle);

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

            applyAvoidTurn(vehicle);
        }

        updateStuckTicks(vehicle, false);
        return false;
    }


    function startObstacleReverse(vehicle) {
        const data = vehicle.getPersistentData();

        data.putInt("sbw_ai_stuck_ticks", 0);
        data.putInt("sbw_ai_reverse_ticks", getObstacleReverseTicks(vehicle));

        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(true);
    }


    function getObstacleReverseTicks(vehicle) {
        const ticks = Math.ceil(getVehicleProbeDistance(vehicle) * OBSTACLE_REVERSE_TICKS_PER_BLOCK);

        return clamp(
            ticks,
            OBSTACLE_REVERSE_MIN_TICKS,
            OBSTACLE_REVERSE_MAX_TICKS
        );
    }


    function getDriveAlignmentState(absDiff) {
        if (absDiff < 35) return "FORWARD";

        if (absDiff > 90) return "REVERSE_ALIGN";

        return "TURN_ONLY";
    }


    // -------------------------------------------------------------------------
    // vCollide movement probes
    // -------------------------------------------------------------------------

    function getFrontMoveProbe(vehicle) {
        return getMovementProbe(
            vehicle,
            getFlatForward(vehicle),
            getVehicleProbeDistance(vehicle),
            "front"
        );
    }


    function getBackMoveProbe(vehicle) {
        return getMovementProbe(
            vehicle,
            getBackDirection(vehicle),
            getVehicleProbeDistance(vehicle),
            "back"
        );
    }


    function getFrontLeftMoveProbe(vehicle) {
        return getMovementProbe(
            vehicle,
            getFrontDiagonalDirection(vehicle, -1),
            getVehicleProbeDistance(vehicle),
            "frontLeft"
        );
    }


    function getFrontRightMoveProbe(vehicle) {
        return getMovementProbe(
            vehicle,
            getFrontDiagonalDirection(vehicle, 1),
            getVehicleProbeDistance(vehicle),
            "frontRight"
        );
    }

    /**
     * @param {$VehicleEntity} vehicle
     * @param {$Vec3} direction
     * @param {number} distance
     * @param {string} label
     */
    function getMovementProbe(vehicle, direction, distance, label) {
        const flat = normalizeFlatDirection(direction);

        const wanted = new $Vec3(
            flat.x() * distance,
            0.0,
            flat.z() * distance
        );

        let allowed = wanted;

        try {
            // This is the important part.
            // vCollide asks Superb Warfare's own OBB/world collision solver
            // how much of this movement would actually be allowed.
            allowed = vehicle.vCollide(wanted);
        } catch (error) {
            allowed = wanted;
        }

        const wantedDistance = horizontalLength(wanted);
        const allowedDistance = horizontalLength(allowed);

        let ratio = 1.0;
        if (wantedDistance > 0.001) {
            ratio = allowedDistance / wantedDistance;
        }

        ratio = clamp(ratio, 0.0, 1.0);

        const probe = {
            label: label,
            wanted: wanted,
            allowed: allowed,
            wantedDistance: wantedDistance,
            allowedDistance: allowedDistance,
            ratio: ratio,
            blocked: ratio < MOVE_BLOCKED_RATIO
        };

        drawMovementProbe(vehicle, probe);

        return probe;
    }


    function chooseAvoidTurnDirectionFromProbes(vehicle, leftProbe, rightProbe) {
        const data = vehicle.getPersistentData();

        let current = getAvoidTurnDirection(vehicle);

        const leftScore = leftProbe.ratio;
        const rightScore = rightProbe.ratio;

        if (rightScore > leftScore + AVOID_SCORE_MARGIN) {
            current = 1;
        } else if (leftScore > rightScore + AVOID_SCORE_MARGIN) {
            current = -1;
        } else if (!rightProbe.blocked && leftProbe.blocked) {
            current = 1;
        } else if (!leftProbe.blocked && rightProbe.blocked) {
            current = -1;
        }

        data.putInt("sbw_ai_avoid_turn_direction", current);
        return current;
    }


    function getVehicleProbeDistance(vehicle) {
        let vehicleLength = 2.0;

        try {
            const aabb = $VehicleMotionUtils.INSTANCE.calculateCombinedAABBOptimized(vehicle);

            const xSize = aabb.maxX - aabb.minX;
            const zSize = aabb.maxZ - aabb.minZ;

            vehicleLength = Math.max(xSize, zSize);
        } catch (error) {
            try {
                vehicleLength = Math.max(vehicle.bbWidth, vehicle.bbHeight);
            } catch (error2) {
                vehicleLength = 2.0;
            }
        }

        const speed = getHorizontalSpeed(vehicle);

        // Faster vehicles look a little farther ahead.
        const distance = vehicleLength * MOVE_PROBE_LENGTH_MULTIPLIER + speed * 8.0;

        // PostEdit: Faster Vehicles will look as far ahead as neccessary.
        // Original:
        // return clamp(
        //     distance,
        //     MOVE_PROBE_DISTANCE_MIN,
        //     MOVE_PROBE_DISTANCE_MAX
        // );
        // Changed:
        return distance;
    }


    function drawMovementProbe(vehicle, probe) {
        if (!DEBUG_DRIVING) return;
        if (vehicle.tickCount % DEBUG_EVERY_TICKS != 0) return;

        const from = new $Vec3(
            vehicle.getX(),
            vehicle.getY() + 0.75,
            vehicle.getZ()
        );

        const wantedTo = new $Vec3(
            from.x() + probe.wanted.x(),
            from.y() + probe.wanted.y(),
            from.z() + probe.wanted.z()
        );

        const allowedTo = new $Vec3(
            from.x() + probe.allowed.x(),
            from.y() + probe.allowed.y(),
            from.z() + probe.allowed.z()
        );

        drawParticleLine(vehicle, from, wantedTo, "minecraft:end_rod", 8);

        if (probe.blocked) {
            vehicle.level.runCommandSilent(
                `particle minecraft:flame ${allowedTo.x()} ${allowedTo.y()} ${allowedTo.z()} 0 0 0 0 2 force`
            );
        } else {
            vehicle.level.runCommandSilent(
                `particle minecraft:glow ${allowedTo.x()} ${allowedTo.y()} ${allowedTo.z()} 0 0 0 0 1 force`
            );
        }
    }


    function drawParticleLine(vehicle, from, to, particle, steps) {
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;

            const x = from.x() + (to.x() - from.x()) * t;
            const y = from.y() + (to.y() - from.y()) * t;
            const z = from.z() + (to.z() - from.z()) * t;

            vehicle.level.runCommandSilent(
                `particle ${particle} ${x} ${y} ${z} 0 0 0 0 1 force`
            );
        }
    }


    // -------------------------------------------------------------------------
    // Panic helpers
    // -------------------------------------------------------------------------

    function vehicleHasLowHealthWarning(vehicle) {
        try {
            return vehicle.data().compute().getHasLowHealthWarning();
        } catch (error) {
        }

        return true;
    }


    function applyReverseAwayFromTarget(vehicle, diff) {
        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(true);

        // Escape steering, not chase steering.
        // If the vehicle turns the wrong way in-game, swap assistedLeft/assistedRight here.
        if (diff < -12) {
            assistedLeft(vehicle);
        } else if (diff > 12) {
            assistedRight(vehicle);
        } else {
            vehicle.setLeftInputDown(false);
            vehicle.setRightInputDown(false);
        }
    }


    function getAwayPositionFromEntity(vehicle, entity) {
        const vx = vehicle.getX();
        const vy = vehicle.getY();
        const vz = vehicle.getZ();

        const ex = entity.getX();
        const ez = entity.getZ();

        return new $Vec3(
            vx + (vx - ex),
            vy,
            vz + (vz - ez)
        );
    }


    function getVehicleHealthRatio(vehicle) {
        const health = getVehicleHealth(vehicle);
        const maxHealth = getVehicleMaxHealth(vehicle);

        if (health < 0 || maxHealth <= 0) return 1.0;

        return health / maxHealth;
    }


    function getVehicleHealth(vehicle) {
        try {
            return vehicle.getEntityData().get($VehicleEntity.HEALTH);
        } catch (error) {
        }

        try {
            return vehicle.health;
        } catch (error) {
        }

        try {
            return vehicle.getHealth();
        } catch (error) {
        }

        return -1;
    }


    function getVehicleMaxHealth(vehicle) {
        try {
            return vehicle.getMaxHealth();
        } catch (error) {
            return -1;
        }
    }


    /** @param {$VehicleEntity} vehicle */
    function getVehicleLastAttackerUuid(vehicle) {

        return vehicle.getLastAttackerUUID() || "";
    }


    /** @param {$VehicleEntity} vehicle */
    function getLastAttackerEntity(vehicle) {
        return vehicle.getLastAttacker();
    }


    // -------------------------------------------------------------------------
    // Direction helpers
    // -------------------------------------------------------------------------

    function getFlatForward(vehicle) {
        const f = vehicle.getForwardDirection();

        const x = f.x();
        const z = f.z();

        const len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return new $Vec3(0, 0, 0);

        return new $Vec3(x / len, 0, z / len);
    }


    function getBackDirection(vehicle) {
        const f = getFlatForward(vehicle);

        return new $Vec3(
            -f.x(),
            0,
            -f.z()
        );
    }


    function getFlatRight(vehicle) {
        const f = getFlatForward(vehicle);

        return new $Vec3(
            -f.z(),
            0,
            f.x()
        );
    }


    function getFrontDiagonalDirection(vehicle, side) {
        const forward = getFlatForward(vehicle);
        const right = getFlatRight(vehicle);

        const x = forward.x() + right.x() * side;
        const z = forward.z() + right.z() * side;

        const len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return forward;

        return new $Vec3(x / len, 0, z / len);
    }


    function normalizeFlatDirection(direction) {
        const x = direction.x();
        const z = direction.z();

        const len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return new $Vec3(0, 0, 0);

        return new $Vec3(x / len, 0, z / len);
    }


    function getDiffToPosition(vehicle, pos) {
        const toPos = vehicle.position().vectorTo(pos).normalize();
        const vehicleVec = vehicle.getViewVector(1.0).normalize();

        return $Mth.wrapDegrees(
            -$VehicleVecUtils.getYRotFromVector(toPos)
            + $VehicleVecUtils.getYRotFromVector(vehicleVec)
        );
    }


    // -------------------------------------------------------------------------
    // Input helpers
    // -------------------------------------------------------------------------

    function steerTowardDiff(vehicle, diff, absDiff) {
        if (absDiff > 12) {
            if (diff < -12) assistedLeft(vehicle);
            if (diff > 12) assistedRight(vehicle);
        } else {
            vehicle.setLeftInputDown(false);
            vehicle.setRightInputDown(false);
        }
    }


    function assistedRight(vehicle) {
        vehicle.setLeftInputDown(false);
        vehicle.setRightInputDown(true);
        return true;
    }


    function assistedLeft(vehicle) {
        vehicle.setLeftInputDown(true);
        vehicle.setRightInputDown(false);
        return true;
    }


    function holdVehicle(vehicle) {
        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(false);
    }


    function stopVehicle(vehicle, driver) {
        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(false);
        vehicle.setLeftInputDown(false);
        vehicle.setRightInputDown(false);
        vehicle.setUpInputDown(false);
        vehicle.setDownInputDown(false);
        vehicle.setSprintInputDown(false);
    }


    function applyAvoidTurn(vehicle) {
        const turnDirection = getAvoidTurnDirection(vehicle);

        if (turnDirection > 0) {
            assistedRight(vehicle);
        } else {
            assistedLeft(vehicle);
        }
    }


    function getAvoidTurnDirection(vehicle) {
        const data = vehicle.getPersistentData();

        let direction = data.getInt("sbw_ai_avoid_turn_direction");

        if (direction == 0) {
            direction = 1; // 1 = right, -1 = left
            data.putInt("sbw_ai_avoid_turn_direction", direction);
        }

        return direction;
    }


    function flipAvoidTurnDirection(vehicle) {
        const data = vehicle.getPersistentData();

        const direction = getAvoidTurnDirection(vehicle);
        data.putInt("sbw_ai_avoid_turn_direction", -direction);
    }


    function startReverseAlign(vehicle) {
        const data = vehicle.getPersistentData();

        data.putInt("sbw_ai_reverse_align_ticks", REVERSE_ALIGN_MAX_TICKS);

        data.putInt(
            "sbw_ai_reverse_align_cooldown",
            REVERSE_ALIGN_MAX_TICKS + REVERSE_ALIGN_COOLDOWN_TICKS
        );
    }


    function applyReverseAlign(vehicle, diff) {
        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(true);

        // For reverse driving, steering may need to be opposite.
        // If it turns the wrong way in-game, swap these two.
        if (diff < -12) {
            assistedRight(vehicle);
        } else if (diff > 12) {
            assistedLeft(vehicle);
        } else {
            vehicle.setLeftInputDown(false);
            vehicle.setRightInputDown(false);
        }
    }


    function canStartReverseAlign(vehicle) {
        const data = vehicle.getPersistentData();

        return data.getInt("sbw_ai_reverse_align_ticks") <= 0
            && data.getInt("sbw_ai_reverse_align_cooldown") <= 0;
    }


    function stopReverseAlign(vehicle) {
        const data = vehicle.getPersistentData();

        data.putInt("sbw_ai_reverse_align_ticks", 0);
    }


    function assistedCreepForward(vehicle) {
        const data = vehicle.getPersistentData();

        let creepTicks = data.getInt("sbw_ai_creep_forward_ticks");

        if (creepTicks > 0) {
            data.putInt("sbw_ai_creep_forward_ticks", creepTicks - 1);

            vehicle.setForwardInputDown(true);
            vehicle.setBackInputDown(false);

            return true;
        }

        const cooldown = data.getInt("sbw_ai_creep_forward_cooldown");

        if (cooldown > 0) {
            holdVehicle(vehicle);
            return false;
        }

        data.putInt("sbw_ai_creep_forward_ticks", CREEP_FORWARD_TICKS);
        data.putInt("sbw_ai_creep_forward_cooldown", CREEP_FORWARD_COOLDOWN_TICKS);

        vehicle.setForwardInputDown(true);
        vehicle.setBackInputDown(false);

        return true;
    }


    // -------------------------------------------------------------------------
    // Timers / stuck logic
    // -------------------------------------------------------------------------

    function updateDrivingTimers(vehicle) {
        const data = vehicle.getPersistentData();

        decrementTimer(data, "sbw_ai_reverse_align_cooldown");
        decrementTimer(data, "sbw_ai_creep_forward_cooldown");
    }


    function decrementTimer(data, key) {
        const value = data.getInt(key);

        if (value > 0) {
            data.putInt(key, value - 1);
        }
    }


    function updateFrontBlockedTicks(vehicle, frontBlocked) {
        const data = vehicle.getPersistentData();

        if (!frontBlocked) {
            data.putInt("sbw_ai_front_blocked_ticks", 0);
            return 0;
        }

        const ticks = data.getInt("sbw_ai_front_blocked_ticks") + 1;
        data.putInt("sbw_ai_front_blocked_ticks", ticks);

        return ticks;
    }


    function getHorizontalSpeed(vehicle) {
        const movement = vehicle.getDeltaMovement();

        const x = movement.x();
        const z = movement.z();

        return Math.sqrt(x * x + z * z);
    }


    function updateStuckTicks(vehicle, wantedToMove) {
        const data = vehicle.getPersistentData();

        if (!wantedToMove) {
            data.putInt("sbw_ai_stuck_ticks", 0);
            return 0;
        }

        const speed = getHorizontalSpeed(vehicle);

        const minimumMovingSpeed = 0.06;

        if (speed < minimumMovingSpeed) {
            const stuckTicks = data.getInt("sbw_ai_stuck_ticks") + 1;
            data.putInt("sbw_ai_stuck_ticks", stuckTicks);
            return stuckTicks;
        }

        data.putInt("sbw_ai_stuck_ticks", 0);
        return 0;
    }


    function updateRecoveryCooldown(vehicle) {
        const data = vehicle.getPersistentData();

        let cooldown = data.getInt("sbw_ai_collision_recovery");

        if (cooldown > 0) {
            data.putInt("sbw_ai_collision_recovery", cooldown - 1);
        }
    }


    function isVehicleCollidingThisTick(vehicle) {
        return vehicle.horizontalCollision;
    }


    function startCollisionRecovery(vehicle) {
        const data = vehicle.getPersistentData();

        data.putInt("sbw_ai_collision_recovery", 10);
    }


    function isRecoveringFromCollision(vehicle) {
        return vehicle.getPersistentData().getInt("sbw_ai_collision_recovery") > 0;
    }


    // -------------------------------------------------------------------------
    // Debug / math
    // -------------------------------------------------------------------------

    function debugDriving(vehicle, message) {
        if (!DEBUG_DRIVING) return;
        if (vehicle.tickCount % DEBUG_EVERY_TICKS != 0) return;

        vehicle.level.runCommandSilent(
            `title @a actionbar {"text":"[SDA] ${message}","color":"yellow"}`
        );
    }


    function horizontalLength(vec) {
        const x = vec.x();
        const z = vec.z();

        return Math.sqrt(x * x + z * z);
    }


    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

})();