// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare

(() => {

    // kubejs/server_scripts/SuperbDrivingAssistance.js
    const DEBUG_DRIVING = true;
    const DEBUG_EVERY_TICKS = 5;

    const REVERSE_ALIGN_MAX_TICKS = 64;
    const REVERSE_ALIGN_COOLDOWN_TICKS = 18;

    const CREEP_FORWARD_TICKS = 3;
    const CREEP_FORWARD_COOLDOWN_TICKS = 8;

    // Matches VehicleEffectUtils.lowHealthWarning:
    // smoke starts at vehicle.health <= 0.4 * vehicle.getMaxHealth()
    // only when vehicle.data().compute().hasLowHealthWarning is true.
    const SMOKE_HEALTH_RATIO = 0.40;

    // If attacker is in front-ish, reverse away.
    // If attacker is behind-ish, drive forward away.
    const PANIC_FORWARD_ANGLE = 70;

    const { $UUID } = require("@package/java/util");
    const { $ClipContext$Block, $ClipContext$Fluid, $ClipContext } = require("@package/net/minecraft/world/level");
    const { $OBB } = require("@package/com/atsuishio/superbwarfare/tools");
    const { $BlockPos } = require("@package/net/minecraft/core");
    const { $HitResult$Type } = require("@package/net/minecraft/world/phys");
    const { $Player } = require("@package/net/minecraft/world/entity/player");
    const { $PlayerInteractEvent$EntityInteract } = require("@package/net/neoforged/neoforge/event/entity/player");
    const { $EntityTickEvent$Pre } = require("@package/net/neoforged/neoforge/event/tick");
    const { $VehicleEntity } = require("@package/com/atsuishio/superbwarfare/entity/vehicle/base");
    const { $VehicleVecUtils, $VehicleMiscUtils, $VehicleMotionUtils } = require("@package/com/atsuishio/superbwarfare/entity/vehicle/utils");
    const { $Monster } = require("@package/net/minecraft/world/entity/monster");
    const { $LivingEntity } = require("@package/net/minecraft/world/entity");
    const { $Mth } = require("@package/net/minecraft/util");
    const { $Vec3, $AABB } = require("@package/net/minecraft/world/phys");


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

        // Quickly find a random driver
        const driver = event.getEntity();
        // Driver is not a Living Entity
        if (!(driver instanceof $LivingEntity)) return;
        // Cannot be players
        if (driver.isPlayer()) return;

        // Tick Staggering
        // Each Entity only checks once every 5 ticks
        // if ((driver.tickCount + driver.getId()) % 5 != 0) return

        // Not on the client
        if (driver.level.isClientSide()) return;

        const vehicle = driver.getVehicle();

        // Driver is not in a vehicle
        if (vehicle == null) return;

        // Vehicle is not a vehicle
        if (!(vehicle instanceof $VehicleEntity)) return;

        // Only the first passenger should drive
        if (vehicle.getFirstPassenger() != driver) return;

        // Vehicle is hostile
        vehicle.getPersistentData().putBoolean("sbw_ai_is_hostile", (driver instanceof $Monster));

        // For now: do nothing except prove we reached the vehicle-driver state.
        // Later this becomes steering / forward / reverse logic.
        stopVehicle(vehicle, driver)
        moveVehicle(vehicle, driver)
    });

    function debugDriving(vehicle, message) {
        if (!DEBUG_DRIVING) return;
        if (vehicle.tickCount % DEBUG_EVERY_TICKS != 0) return;

        // Actionbar instead of chat spam.
        vehicle.level.runCommandSilent(
            `title @a actionbar {"text":"[SDA] ${message}","color":"yellow"}`
        );
    }
    function getRayDebug(vehicle) {
        const distance = getVehicleRayDistance(vehicle);
        const from = getVehicleFrontRayStart(vehicle);
        const forward = vehicle.getForwardDirection();

        const to = new $Vec3(
            from.x() + forward.x() * distance,
            from.y(),
            from.z() + forward.z() * distance
        );

        const context = new $ClipContext(
            from,
            to,
            $ClipContext$Block.COLLIDER,
            $ClipContext$Fluid.NONE,
            vehicle
        );

        const hit = vehicle.level.clip(context);

        if (hit == null) return "hit=null";
        if (hit.getType() == $HitResult$Type.MISS) return "hit=MISS";

        const loc = hit.getLocation();

        return `hit=${hit.getType()} ${loc.x().toFixed(1)},${loc.y().toFixed(1)},${loc.z().toFixed(1)}`;
    }

    function moveVehicle(vehicle, driver) {
        const followRange = driver.getAttributeValue("minecraft:generic.follow_range");

        // Safety system runs first.
        // This does not care whether the mob driver has a normal target.
        if (tryPanicEscape(vehicle, driver, followRange)) {
            return;
        }

        // Normal combat driving starts only after panic says "not my problem."
        const target = driver.getTarget ? driver.getTarget() : null;
        if (!(target instanceof $LivingEntity)) return;

        updateRecoveryCooldown(vehicle);

        const diff = getDiffToPosition(vehicle, target.position());
        const absDiff = Math.abs(diff);

        steerTowardDiff(vehicle, diff, absDiff);

        const distance = vehicle.distanceToEntity(target);

        assistedDrive(vehicle, distance, followRange, diff, absDiff);
    }

    function tryPanicEscape(vehicle, driver, followRange) {
        const healthRatio = getVehicleHealthRatio(vehicle);
        const warning = vehicleHasLowHealthWarning(vehicle);
        const attackerUuid = getVehicleLastAttackerUuid(vehicle);

        // Debug this even when panic fails, because this is how we find the broken link.
        debugDriving(
            vehicle,
            `panicCheck hp=${healthRatio.toFixed(2)} smoke=${SMOKE_HEALTH_RATIO.toFixed(2)} warning=${warning} uuid=${attackerUuid}`
        );

        if (!warning) return false;
        if (healthRatio > SMOKE_HEALTH_RATIO) return false;
        if (attackerUuid == "") return false;

        const attacker = getLastAttackerEntity(vehicle);

        if (!(attacker instanceof $LivingEntity)) {
            debugDriving(
                vehicle,
                `panicFail uuidFoundButEntityMissing uuid=${attackerUuid}`
            );

            return false;
        }

        const panicDistance = vehicle.distanceToEntity(attacker);

        // If we escaped the attacker's relevant range, stop the vehicle.
        // Do not instantly return to normal chase while smoking.
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


    function shouldPanic(vehicle) {
        const healthRatio = getVehicleHealthRatio(vehicle);
        const lastAttackerUuid = getVehicleLastAttackerUuid(vehicle);

        return vehicleHasLowHealthWarning(vehicle)
            && healthRatio <= SMOKE_HEALTH_RATIO
            && lastAttackerUuid != "";
    }

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

        // This is escape steering, not chase steering.
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

    function assistedPanicDrive(vehicle, attacker, distance, followRange) {
        const data = vehicle.getPersistentData();

        updateDrivingTimers(vehicle);

        const healthRatio = getVehicleHealthRatio(vehicle);
        const diffToAttacker = getDiffToPosition(vehicle, attacker.position());
        const absDiffToAttacker = Math.abs(diffToAttacker);

        const frontBlocked = isFrontRayBlocked(vehicle);
        const speed = getHorizontalSpeed(vehicle);

        debugDriving(
            vehicle,
            `PANIC smokeAt=${SMOKE_HEALTH_RATIO.toFixed(2)} hp=${healthRatio.toFixed(2)} warning=${vehicleHasLowHealthWarning(vehicle)} dist=${distance.toFixed(1)}/${followRange.toFixed(1)} attacker=${attacker.getName().getString()} diff=${diffToAttacker.toFixed(1)} front=${frontBlocked} speed=${speed.toFixed(2)}`
        );

        // Do not panic-drive straight into an obstacle.
        const frontBlockedTicks = updateFrontBlockedTicks(vehicle, frontBlocked);

        if (frontBlocked) {
            const leftBlocked = isFrontLeftRayBlocked(vehicle);
            const rightBlocked = isFrontRightRayBlocked(vehicle);

            chooseAvoidTurnDirection(vehicle, leftBlocked, rightBlocked);

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(false);
            applyAvoidTurn(vehicle);

            if (frontBlockedTicks >= 10) {
                data.putInt("sbw_ai_front_blocked_ticks", 0);

                const reverseTicks = Math.ceil(getVehicleRayDistance(vehicle) * 2);
                data.putInt("sbw_ai_reverse_ticks", reverseTicks);

                vehicle.setForwardInputDown(false);
                vehicle.setBackInputDown(true);
                applyAvoidTurn(vehicle);
            }

            updateStuckTicks(vehicle, false);
            return false;
        }

        // If attacker is in front-ish, reverse away.
        if (absDiffToAttacker < 100) {
            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

            applyReverseAwayFromTarget(vehicle, diffToAttacker);

            updateStuckTicks(vehicle, true);
            return true;
        }

        // If attacker is behind-ish, drive forward away.
        const awayPos = getAwayPositionFromEntity(vehicle, attacker);
        const diffAway = getDiffToPosition(vehicle, awayPos);
        const absDiffAway = Math.abs(diffAway);

        steerTowardDiff(vehicle, diffAway, absDiffAway);

        if (absDiffAway < PANIC_FORWARD_ANGLE) {
            vehicle.setForwardInputDown(true);
            vehicle.setBackInputDown(false);

            const stuckTicks = updateStuckTicks(vehicle, true);

            if (stuckTicks >= 10) {
                data.putInt("sbw_ai_stuck_ticks", 0);

                const reverseTicks = Math.ceil(getVehicleRayDistance(vehicle) * 2);
                data.putInt("sbw_ai_reverse_ticks", reverseTicks);

                vehicle.setForwardInputDown(false);
                vehicle.setBackInputDown(true);
                applyAvoidTurn(vehicle);

                return false;
            }

            return true;
        }

        assistedCreepForward(vehicle);
        updateStuckTicks(vehicle, true);
        return true;
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
        const uuid = String(vehicle.getEntityData().get($VehicleEntity.LAST_ATTACKER_UUID));

        if (uuid && uuid != "" && uuid != "undefined") {
            return String(uuid);
        }

        return "";
    }

    /** @param {$VehicleEntity} vehicle */
    function getLastAttackerEntity(vehicle) {
        const uuidString = getVehicleLastAttackerUuid(vehicle);

        if (!uuidString) return null;

        try {
            return vehicle.level.getEntityByUUID(uuidString);
        } catch (error) {
            return null;
        }
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

        // side = 1 means right
        // side = -1 means left
        const x = forward.x() + right.x() * side;
        const z = forward.z() + right.z() * side;

        const len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return forward;

        return new $Vec3(x / len, 0, z / len);
    }

    function getFlatForward(vehicle) {
        const f = vehicle.getForwardDirection();

        const x = f.x();
        const z = f.z();

        const len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return new $Vec3(0, 0, 0);

        return new $Vec3(x / len, 0, z / len);
    }

    /**
     * Draws the outline of an AABB with particles.
     *
     * @param {$VehicleEntity} vehicle
     * @param {$AABB} aabb
     */
    function drawBox(vehicle, aabb) {
        const center = aabb.getCenter();

        vehicle.level.runCommandSilent(`particle minecraft:glow ${center.x()} ${center.y()} ${center.z()} 0 0 0 0 1 force`);
        vehicle.level.runCommandSilent(`particle minecraft:glow ${aabb.maxX} ${aabb.maxY} ${aabb.maxZ} 0 0 0 0 1 force`);
        vehicle.level.runCommandSilent(`particle minecraft:glow ${aabb.minX} ${aabb.minY} ${aabb.minZ} 0 0 0 0 1 force`);
    }

    function steerTowardDiff(vehicle, diff, absDiff) {
        if (absDiff > 12) {
            if (diff < -12) assistedLeft(vehicle);
            if (diff > 12) assistedRight(vehicle);
        } else {
            vehicle.setLeftInputDown(false);
            vehicle.setRightInputDown(false);
        }
    }

    function startReverseAlign(vehicle) {
        const data = vehicle.getPersistentData();

        data.putInt("sbw_ai_reverse_align_ticks", REVERSE_ALIGN_MAX_TICKS);

        // This prevents REVERSE_ALIGN from immediately restarting forever.
        // We include the active time + extra cooldown.
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

    function assistedDrive(vehicle, distance, followRange, diff, absDiff) {
        const data = vehicle.getPersistentData();

        updateDrivingTimers(vehicle);

        let reverseTicks = data.getInt("sbw_ai_reverse_ticks");
        let reverseAlignTicks = data.getInt("sbw_ai_reverse_align_ticks");

        const frontBlocked = isFrontRayBlocked(vehicle);
        const collision = isVehicleCollidingThisTick(vehicle);
        const speed = getHorizontalSpeed(vehicle);

        const driveState = getDriveAlignmentState(absDiff);

        debugDriving(
            vehicle,
            `state=${driveState} diff=${diff.toFixed(1)} front=${frontBlocked} speed=${speed.toFixed(2)} reverse=${reverseTicks} align=${reverseAlignTicks} alignCd=${data.getInt("sbw_ai_reverse_align_cooldown")} creep=${data.getInt("sbw_ai_creep_forward_ticks")} stuck=${data.getInt("sbw_ai_stuck_ticks")}`
        );

        // Active reverse-align maneuver.
        // This is now limited. It cannot run forever.
        if (reverseAlignTicks > 0) {
            data.putInt("sbw_ai_reverse_align_ticks", reverseAlignTicks - 1);

            // If we have swung around enough, stop reversing early.
            if (absDiff < 45) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                updateStuckTicks(vehicle, false);
                return false;
            }

            // If we reversed too far away, stop reversing early.
            if (distance > followRange * 0.6) {
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

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

            applyAvoidTurn(vehicle);

            updateStuckTicks(vehicle, true);
            return true;
        }

        const frontBlockedTicks = updateFrontBlockedTicks(vehicle, frontBlocked);

        if (frontBlocked) {
            const leftBlocked = isFrontLeftRayBlocked(vehicle);
            const rightBlocked = isFrontRightRayBlocked(vehicle);

            const turnDirection = chooseAvoidTurnDirection(vehicle, leftBlocked, rightBlocked);

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(false);

            if (turnDirection > 0) {
                assistedRight(vehicle);
            } else {
                assistedLeft(vehicle);
            }

            if (frontBlockedTicks >= 10) {
                data.putInt("sbw_ai_front_blocked_ticks", 0);

                const reverseTicks = Math.ceil(getVehicleRayDistance(vehicle) * 2);
                data.putInt("sbw_ai_reverse_ticks", reverseTicks);

                vehicle.setForwardInputDown(false);
                vehicle.setBackInputDown(true);

                applyAvoidTurn(vehicle);
            }

            updateStuckTicks(vehicle, false);
            return false;
        }

        if (driveState == "REVERSE_ALIGN") {
            if (canStartReverseAlign(vehicle)) {
                startReverseAlign(vehicle);
                applyReverseAlign(vehicle, diff);

                updateStuckTicks(vehicle, true);
                return true;
            }

            // Cooldown active.
            // Do not restart reverse immediately.
            holdVehicle(vehicle);
            updateStuckTicks(vehicle, false);
            return false;
        }

        if (driveState == "TURN_ONLY") {
            // Instead of infinite reverse, use a tiny forward pulse.
            // This gives wheeled vehicles some movement so steering can matter,
            // without full-throttle circling forever.
            assistedCreepForward(vehicle);

            updateStuckTicks(vehicle, true);
            return true;
        }

        // FORWARD
        vehicle.setForwardInputDown(true);
        vehicle.setBackInputDown(false);

        const stuckTicks = updateStuckTicks(vehicle, true);

        if (stuckTicks >= 10) {
            data.putInt("sbw_ai_stuck_ticks", 0);

            const reverseTicks = Math.ceil(getVehicleRayDistance(vehicle) * 2);
            data.putInt("sbw_ai_reverse_ticks", reverseTicks);

            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

            return false;
        }

        return true;
    }

    function getDriveAlignmentState(absDiff) {
        if (absDiff < 35) return "FORWARD";

        // Target is far enough off-angle that a wheeled vehicle should not just
        // full-throttle circle. Back up while steering to swing the front around.
        if (absDiff > 90) return "REVERSE_ALIGN";

        return "TURN_ONLY";
    }

    function invertCurrentSteering(vehicle) {
        const left = vehicle.leftInputDown();
        const right = vehicle.rightInputDown();

        vehicle.setLeftInputDown(right);
        vehicle.setRightInputDown(left);
    }

    function flipAvoidTurnDirection(vehicle) {
        const data = vehicle.getPersistentData();

        const direction = getAvoidTurnDirection(vehicle);
        data.putInt("sbw_ai_avoid_turn_direction", -direction);
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

        // Tune this number.
        // 0.03 = very sensitive
        // 0.06 = decent starting point
        // 0.10 = only counts as stuck if almost not moving
        const minimumMovingSpeed = 0.06;

        if (speed < minimumMovingSpeed) {
            const stuckTicks = data.getInt("sbw_ai_stuck_ticks") + 1;
            data.putInt("sbw_ai_stuck_ticks", stuckTicks);
            return stuckTicks;
        }

        data.putInt("sbw_ai_stuck_ticks", 0);
        return 0;
    }

    /**
     * 
     * @param {$VehicleEntity} vehicle 
     * @returns 
     */
    function isVehicleCollidingThisTick(vehicle) {
        return vehicle.horizontalCollision;
    }

    function startCollisionRecovery(vehicle) {
        const data = vehicle.getPersistentData();

        // Since you are currently ticking every tick, 10 = half a second.
        data.putInt("sbw_ai_collision_recovery", 10);
    }

    function isRecoveringFromCollision(vehicle) {
        return vehicle.getPersistentData().getInt("sbw_ai_collision_recovery") > 0;
    }

    function holdVehicle(vehicle) {
        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(false);
    }

    function stopVehicle(vehicle, driver) {
        vehicle.setForwardInputDown(false)
        vehicle.setBackInputDown(false)
        vehicle.setLeftInputDown(false)
        vehicle.setRightInputDown(false)
        vehicle.setUpInputDown(false)
        vehicle.setDownInputDown(false)
        vehicle.setSprintInputDown(false)
    }

    function updateRecoveryCooldown(vehicle) {
        const data = vehicle.getPersistentData();

        let cooldown = data.getInt("sbw_ai_collision_recovery");

        if (cooldown > 0) {
            data.putInt("sbw_ai_collision_recovery", cooldown - 1);
        }
    }
    function isVehicleRayBlocked(vehicle, direction, distance) {
        const from = getVehicleFrontRayStart(vehicle);

        const to = new $Vec3(
            from.x() + direction.x() * distance,
            from.y(),
            from.z() + direction.z() * distance
        );

        const context = new $ClipContext(
            from,
            to,
            $ClipContext$Block.COLLIDER,
            $ClipContext$Fluid.NONE,
            vehicle
        );

        const hit = vehicle.level.clip(context);

        drawCustomRayLine(vehicle, from, to, hit);

        return hit != null && hit.getType() != $HitResult$Type.MISS;
    }

    function isFrontRayBlocked(vehicle) {
        return isVehicleRayBlocked(
            vehicle,
            getFlatForward(vehicle),
            getVehicleRayDistance(vehicle)
        );
    }
    function isFrontLeftRayBlocked(vehicle) {
        return isVehicleRayBlocked(
            vehicle,
            getFrontDiagonalDirection(vehicle, -1),
            getVehicleRayDistance(vehicle)
        );
    }

    function isFrontRightRayBlocked(vehicle) {
        return isVehicleRayBlocked(
            vehicle,
            getFrontDiagonalDirection(vehicle, 1),
            getVehicleRayDistance(vehicle)
        );
    }

    function chooseAvoidTurnDirection(vehicle, leftBlocked, rightBlocked) {
        const data = vehicle.getPersistentData();

        let current = getAvoidTurnDirection(vehicle);

        if (!rightBlocked && leftBlocked) {
            current = 1;
        } else if (!leftBlocked && rightBlocked) {
            current = -1;
        } else if (!leftBlocked && !rightBlocked) {
            // Both open: keep current direction.
        } else {
            // Both blocked: keep current direction and reverse.
        }

        data.putInt("sbw_ai_avoid_turn_direction", current);
        return current;
    }

    function applyAvoidTurn(vehicle) {
        const turnDirection = getAvoidTurnDirection(vehicle);

        if (turnDirection > 0) {
            assistedRight(vehicle);
        } else {
            assistedLeft(vehicle);
        }
    }

    function getVehicleRayDistance(vehicle) {
        const aabb = $VehicleMotionUtils.INSTANCE.calculateCombinedAABBOptimized(vehicle);

        const xSize = aabb.maxX - aabb.minX;
        const zSize = aabb.maxZ - aabb.minZ;

        const vehicleLength = Math.max(xSize, zSize);

        return Math.max(4.0, vehicleLength * 1.5);
    }

    function getVehicleFrontRayStart(vehicle) {
        const aabb = $VehicleMotionUtils.INSTANCE.calculateCombinedAABBOptimized(vehicle);
        const center = aabb.getCenter();
        const forward = vehicle.getForwardDirection();

        const xSize = aabb.maxX - aabb.minX;
        const zSize = aabb.maxZ - aabb.minZ;
        const ySize = aabb.maxY - aabb.minY;

        const vehicleLength = Math.max(xSize, zSize);

        const frontOffset = vehicleLength * 0.5 + 1.0;

        // Start around middle/upper-middle of the vehicle, not low near the ground.
        const rayY = aabb.minY + ySize * 0.6;

        return new $Vec3(
            center.x() + forward.x() * frontOffset,
            rayY,
            center.z() + forward.z() * frontOffset
        );
    }

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

    function drawCustomRayLine(vehicle, from, to, hit) {
        if (!DEBUG_DRIVING) return;
        if (vehicle.tickCount % DEBUG_EVERY_TICKS != 0) return;

        const steps = 12;

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;

            const x = from.x() + (to.x() - from.x()) * t;
            const y = from.y() + (to.y() - from.y()) * t;
            const z = from.z() + (to.z() - from.z()) * t;

            vehicle.level.runCommandSilent(
                `particle minecraft:end_rod ${x} ${y} ${z} 0 0 0 0 1 force`
            );
        }

        if (hit != null && hit.getType() != $HitResult$Type.MISS) {
            const loc = hit.getLocation();

            vehicle.level.runCommandSilent(
                `particle minecraft:flame ${loc.x()} ${loc.y()} ${loc.z()} 0 0 0 0 3 force`
            );
        }
    }

    function getDiffToPosition(vehicle, pos) {
        const toPos = vehicle.position().vectorTo(pos).normalize();

        const vehicleVec = vehicle.getViewVector(1.0).normalize();

        return $Mth.wrapDegrees(
            -$VehicleVecUtils.getYRotFromVector(toPos)
            + $VehicleVecUtils.getYRotFromVector(vehicleVec)
        );
    }

})();
