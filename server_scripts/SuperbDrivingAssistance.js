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

    // Ray fan tuning.
    // Ray fan = eyes.
    // vCollide = final body check.
    const MOVE_PROBE_SPEED_LOOKAHEAD = 8.0;

    const RAY_SIDE_INSET = 0.20;
    const RAY_MIN_HALF_WIDTH = 0.35;
    const RAY_DEBUG_STEPS = 4;

    const RAY_FRONT_END_EXTRA = 0.75;
    const RAY_SIDE_MARGIN = 0.10;

    // Debug mode:
    const RAY_SIDE_FRACTIONS = [-1.0, -0.66, -0.33, 0.0, 0.33, 0.66, 1.0];

    // Later, once calibrated:
    // const RAY_SIDE_FRACTIONS = [-0.90, -0.45, 0.0, 0.45, 0.90];

    const RAY_HEIGHT_FRACTIONS = [0.30, 0.58, 0.82];


    // If Superb Warfare allows less than this much of the requested movement,
    // treat the path as blocked.
    const MOVE_BLOCKED_RATIO = 0.55;

    // Used when choosing left vs right.
    // Prevents tiny score differences from constantly flipping steering.
    const AVOID_SCORE_MARGIN = 0.10;

    const OBSTACLE_REVERSE_MIN_TICKS = 12;
    const OBSTACLE_REVERSE_MAX_TICKS = 40;
    const OBSTACLE_REVERSE_TICKS_PER_BLOCK = 5;

    // Per-tick local cache. Avoids rescanning OBBs 3-8 times during one vehicle tick.
    const SENSOR_OBB_CACHE = {};

    // Less for more narrow angles
    const TURN_ANGLE_THRESHOLD = 6;

    const { $ClipContext } = require("@package/net/minecraft/world/level");
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

    // Utility for debug used to place
    NativeEvents.onEvent($PlayerInteractEvent$EntityInteract, (event) => {

        let player = event.getEntity();
        if (player instanceof $Player) {
            if (player.level.isClientSide()) return;

            let lead = player.getMainHandItem().copy();
            if (lead && lead.getIdLocation() === Item.of("minecraft:lead").getIdLocation()) {

                let target = event.getTarget();
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

        let driver = event.getEntity();

        if (!(driver instanceof $LivingEntity)) return;
        if (driver.isPlayer()) return;
        if (driver.level.isClientSide()) return;

        let vehicle = driver.getVehicle();

        if (vehicle == null) return;
        if (!(vehicle instanceof $VehicleEntity)) return;
        if (vehicle.getFirstPassenger() != driver) return;
        vehicle.getPersistentData().putBoolean("sbw_ai_is_hostile", (driver instanceof $Monster));
        stopVehicle(vehicle, driver);
        moveVehicle(vehicle, driver);
    });


    function moveVehicle(vehicle, driver) {
        let followRange = driver.getAttributeValue("minecraft:generic.follow_range");

        // Safety system runs first.
        // This does not care whether the mob driver has a normal target.
        if (tryPanicEscape(vehicle, driver, followRange)) {
            return;
        }

        let target = driver.getTarget ? driver.getTarget() : null;
        if (!(target instanceof $LivingEntity)) return;

        updateRecoveryCooldown(vehicle);
        updateDrivingTimers(vehicle);

        let diff = getDiffToPosition(vehicle, target.position());
        let absDiff = Math.abs(diff);

        steerTowardDiff(vehicle, diff, absDiff);

        let distance = vehicle.distanceToEntity(target);

        assistedDrive(vehicle, distance, followRange, diff, absDiff);
    }


    /**
     * Panic escape.
     * @param {$VehicleEntity} vehicle 
     * @param {$LivingEntity} driver 
     * @param {Number} followRange
     */
    function tryPanicEscape(vehicle, driver, followRange) {
        let healthRatio = getVehicleHealthRatio(vehicle);
        let warning = vehicleHasLowHealthWarning(vehicle);
        let attackerUuid = getVehicleLastAttackerUuid(vehicle);

        debugDriving(
            vehicle,
            `panicCheck hp=${healthRatio.toFixed(2)} smoke=${SMOKE_HEALTH_RATIO.toFixed(2)} warning=${warning} uuid=${attackerUuid}`
        );

        if (!warning) return false;
        if (healthRatio > SMOKE_HEALTH_RATIO) return false;
        if (attackerUuid == "") return false;

        let attacker = getLastAttackerEntity(vehicle);

        // Last Attacker cannot equal a passanger of the vehicle.
        // Last Attacker cannot be within the vehicles bounding.
        if (!(attacker instanceof $LivingEntity) || vehicle.isPassengerOfSameVehicle(attacker) || attacker == vehicle) {
            debugDriving(
                vehicle,
                `panicFail uuidFoundButEntityMissing uuid=${attackerUuid}`
            );

            return false;
        }

        let panicDistance = vehicle.distanceToEntity(attacker);

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

        let healthRatio = getVehicleHealthRatio(vehicle);
        let diffToAttacker = getDiffToPosition(vehicle, attacker.position());
        let absDiffToAttacker = Math.abs(diffToAttacker);

        let speed = getHorizontalSpeed(vehicle);

        // If attacker is in front-ish, reverse away.
        if (absDiffToAttacker < 100) {
            let backProbe = getBackMoveProbe(vehicle);

            debugDriving(
                vehicle,
                `PANIC reverse hp=${healthRatio.toFixed(2)} dist=${distance.toFixed(1)}/${followRange.toFixed(1)} attacker=${attacker.getName().getString()} diff=${diffToAttacker.toFixed(1)} backFit=${backProbe.ratio.toFixed(2)} ray=${backProbe.rayRatio.toFixed(2)} body=${backProbe.bodyRatio.toFixed(2)} speed=${speed.toFixed(2)}`
            );

            if (backProbe.blocked) {
                // Backing up would collide. Do not ram backward forever.
                // Pick the better forward diagonal and rotate.
                let leftProbe = getFrontLeftMoveProbe(vehicle);
                let rightProbe = getFrontRightMoveProbe(vehicle);

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
        let awayPos = getAwayPositionFromEntity(vehicle, attacker);
        let diffAway = getDiffToPosition(vehicle, awayPos);
        let absDiffAway = Math.abs(diffAway);

        steerTowardDiff(vehicle, diffAway, absDiffAway);

        let frontProbe = getFrontMoveProbe(vehicle);
        let frontBlockedTicks = updateFrontBlockedTicks(vehicle, frontProbe.blocked);

        debugDriving(
            vehicle,
            `PANIC forward hp=${healthRatio.toFixed(2)} dist=${distance.toFixed(1)}/${followRange.toFixed(1)} attacker=${attacker.getName().getString()} awayDiff=${diffAway.toFixed(1)} frontFit=${frontProbe.ratio.toFixed(2)} ray=${frontProbe.rayRatio.toFixed(2)} body=${frontProbe.bodyRatio.toFixed(2)} speed=${speed.toFixed(2)}`
        );

        if (frontProbe.blocked) {
            return handleBlockedForward(vehicle, frontBlockedTicks);
        }

        if (absDiffAway < PANIC_FORWARD_ANGLE) {
            vehicle.setForwardInputDown(true);
            vehicle.setBackInputDown(false);

            let stuckTicks = updateStuckTicks(vehicle, true);

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
        let data = vehicle.getPersistentData();

        let reverseTicks = data.getInt("sbw_ai_reverse_ticks");
        let reverseAlignTicks = data.getInt("sbw_ai_reverse_align_ticks");

        let frontProbe = getFrontMoveProbe(vehicle);
        let speed = getHorizontalSpeed(vehicle);
        let driveState = getDriveAlignmentState(absDiff);

        debugDriving(
            vehicle,
            `state=${driveState} diff=${diff.toFixed(1)} fit=${frontProbe.ratio.toFixed(2)} R=${frontProbe.rayRatio.toFixed(2)} B=${frontProbe.bodyRatio.toFixed(2)} rays=${frontProbe.rays.length} speed=${speed.toFixed(2)} stuck=${data.getInt("sbw_ai_stuck_ticks")}`
        );

        // Active reverse-align maneuver.
        // This is limited, but it should not cancel too eagerly.
        // If it cancels before setting BackInputDown, the vehicle only rolls.
        if (reverseAlignTicks > 0) {
            data.putInt("sbw_ai_reverse_align_ticks", reverseAlignTicks - 1);

            let elapsedAlignTicks = REVERSE_ALIGN_MAX_TICKS - reverseAlignTicks;

            if (absDiff < 45) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                updateStuckTicks(vehicle, false);

                debugDriving(
                    vehicle,
                    `ALIGN stop angle diff=${diff.toFixed(1)}`
                );

                return false;
            }

            // Old value was followRange * 0.6.
            // That is very aggressive and can cancel reverse-align before the vehicle actually backs up.
            // Let reverse-align commit briefly before far-distance cancellation is allowed.
            if (elapsedAlignTicks > 10 && distance > followRange * 0.9) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                updateStuckTicks(vehicle, false);

                debugDriving(
                    vehicle,
                    `ALIGN stop far dist=${distance.toFixed(1)}/${followRange.toFixed(1)}`
                );

                return false;
            }

            let backProbe = getBackMoveProbe(vehicle);

            // Important:
            // Do not let vCollide alone kill reverse-align if rays say the path is open.
            // vCollide can be conservative because it is using the real body/white box.
            // For reverse-align, rays are the "eyes"; vCollide is a warning, not always a hard veto.
            let backRayBlocked = backProbe.rayRatio < MOVE_BLOCKED_RATIO;
            let backBodyBlocked = backProbe.bodyRatio < MOVE_BLOCKED_RATIO;
            let backReallyBlocked = backRayBlocked && backBodyBlocked;

            if (backReallyBlocked) {
                stopReverseAlign(vehicle);
                holdVehicle(vehicle);
                applyAvoidTurn(vehicle);
                updateStuckTicks(vehicle, false);

                debugDriving(
                    vehicle,
                    `ALIGN stop backBlocked ray=${backProbe.rayRatio.toFixed(2)} body=${backProbe.bodyRatio.toFixed(2)}`
                );

                return false;
            }

            applyReverseAlign(vehicle, diff);

            debugDriving(
                vehicle,
                `ALIGN reverse diff=${diff.toFixed(1)} ray=${backProbe.rayRatio.toFixed(2)} body=${backProbe.bodyRatio.toFixed(2)} speed=${getHorizontalSpeed(vehicle).toFixed(2)}`
            );

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

            let backProbe = getBackMoveProbe(vehicle);

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

        let frontBlockedTicks = updateFrontBlockedTicks(vehicle, frontProbe.blocked);

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

        let stuckTicks = updateStuckTicks(vehicle, true);

        if (stuckTicks >= 10) {
            startObstacleReverse(vehicle);
            return false;
        }

        return true;
    }


    function handleBlockedForward(vehicle, frontBlockedTicks) {
        let leftProbe = getFrontLeftMoveProbe(vehicle);
        let rightProbe = getFrontRightMoveProbe(vehicle);

        let turnDirection = chooseAvoidTurnDirectionFromProbes(vehicle, leftProbe, rightProbe);

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
        let data = vehicle.getPersistentData();

        data.putInt("sbw_ai_stuck_ticks", 0);
        data.putInt("sbw_ai_reverse_ticks", getObstacleReverseTicks(vehicle));

        vehicle.setForwardInputDown(false);
        vehicle.setBackInputDown(true);
    }


    function getObstacleReverseTicks(vehicle) {
        let ticks = Math.ceil(getVehicleProbeDistance(vehicle) * OBSTACLE_REVERSE_TICKS_PER_BLOCK);

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
    // Sensor Core V2: collision-OBB ray fan + vCollide body probe
    // -------------------------------------------------------------------------

    function getVehicleProbeDistance(vehicle) {
        let vehicleLength = getVehicleSensorLength(vehicle);
        let speed = getHorizontalSpeed(vehicle);

        let distance = vehicleLength * MOVE_PROBE_LENGTH_MULTIPLIER
            + speed * MOVE_PROBE_SPEED_LOOKAHEAD;

        return clamp(
            distance,
            MOVE_PROBE_DISTANCE_MIN,
            MOVE_PROBE_DISTANCE_MAX
        );
    }


    function getVehicleSensorLength(vehicle) {
        let collisionObb = getKubeCollisionOBB(vehicle);

        if (collisionObb != null) {
            let ext = getObbExtents(collisionObb);

            let x = Math.abs(component(ext, "x"));
            let z = Math.abs(component(ext, "z"));

            // In SuperbWarfare OBB convention, local Z is the front/back axis.
            // If that ever comes back invalid, fall back to the larger horizontal extent.
            let length = Math.max(z * 2.0, Math.max(x, z) * 2.0);

            if (length > 0.01) {
                return length;
            }
        }

        try {
            let box = getBestVehicleSensorBox(vehicle);
            let xSize = box.maxX - box.minX;
            let zSize = box.maxZ - box.minZ;

            return Math.max(xSize, zSize, 2.0);
        } catch (error) {
        }

        try {
            return Math.max(vehicle.bbWidth, vehicle.bbHeight, 2.0);
        } catch (error2) {
        }

        return 2.0;
    }


    function getFrontMoveProbe(vehicle) {
        return getMovementProbe(
            vehicle,
            getVehicleFlatFront(vehicle),
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


    function getMovementProbe(vehicle, direction, distance, label) {
        let flat = normalizeFlatDirection(direction);

        let wanted = new $Vec3(
            flat.x() * distance,
            0.0,
            flat.z() * distance
        );

        // Eyes first.
        let rayProbe = getRayFanProbe(vehicle, flat, distance, label);

        // Body check second.
        let bodyProbe = getVCollideProbe(vehicle, wanted, flat);

        // Normal driving uses the stricter answer.
        // Reverse-align has separate logic that can treat vCollide as advisory.
        let ratio = clamp(
            Math.min(rayProbe.ratio, bodyProbe.ratio),
            0.0,
            1.0
        );

        let allowed = new $Vec3(
            wanted.x() * ratio,
            wanted.y() * ratio,
            wanted.z() * ratio
        );

        let probe = {
            label: label,
            wanted: wanted,
            allowed: allowed,
            wantedDistance: horizontalLength(wanted),
            allowedDistance: horizontalLength(allowed),
            ratio: ratio,
            rayRatio: rayProbe.ratio,
            bodyRatio: bodyProbe.ratio,
            blocked: ratio < MOVE_BLOCKED_RATIO,
            rays: rayProbe.rays,
            bodyAllowed: bodyProbe.allowed,
            frame: rayProbe.frame,
            source: rayProbe.source
        };

        drawMovementProbe(vehicle, probe);

        return probe;
    }


    function chooseAvoidTurnDirectionFromProbes(vehicle, leftProbe, rightProbe) {
        let data = vehicle.getPersistentData();

        let current = getAvoidTurnDirection(vehicle);

        let leftScore = getProbeAvoidScore(leftProbe);
        let rightScore = getProbeAvoidScore(rightProbe);

        if (rightScore > leftScore + AVOID_SCORE_MARGIN) {
            current = 1; // right
        } else if (leftScore > rightScore + AVOID_SCORE_MARGIN) {
            current = -1; // left
        } else if (!rightProbe.blocked && leftProbe.blocked) {
            current = 1;
        } else if (!leftProbe.blocked && rightProbe.blocked) {
            current = -1;
        }

        data.putInt("sbw_ai_avoid_turn_direction", current);
        return current;
    }


    function getProbeAvoidScore(probe) {
        if (probe == null) return 0.0;

        let score = probe.ratio;

        // Slightly prefer paths where both eyes and body agree.
        if (probe.rayRatio != null && probe.bodyRatio != null) {
            score = Math.min(probe.rayRatio, probe.bodyRatio);
        }

        return clamp(score, 0.0, 1.0);
    }


    function getVCollideProbe(vehicle, wanted, flat) {
        let allowed = wanted;

        try {
            allowed = vehicle.vCollide(wanted);
        } catch (error) {
            allowed = wanted;
        }

        let wantedDistance = horizontalLength(wanted);

        let ratio = 1.0;

        if (wantedDistance > 0.001) {
            // Projection matters.
            // If vCollide slides us sideways, that should not count as useful forward progress.
            let progress = allowed.x() * flat.x() + allowed.z() * flat.z();
            ratio = clamp(progress / wantedDistance, 0.0, 1.0);
        }

        return {
            wanted: wanted,
            allowed: allowed,
            ratio: ratio
        };
    }


    function getRayFanProbe(vehicle, flatDirection, distance, label) {
        let frame = getRaySensorFrame(vehicle, flatDirection, distance);
        let rays = [];

        let bestRatio = 1.0;

        for (let sideOffset of frame.sideOffsets) {
            for (let heightY of frame.heightYs) {
                let from = new $Vec3(
                    frame.rayStartCenter.x() + frame.right.x() * sideOffset,
                    heightY,
                    frame.rayStartCenter.z() + frame.right.z() * sideOffset
                );

                let to = new $Vec3(
                    from.x() + flatDirection.x() * frame.rayDistance,
                    from.y(),
                    from.z() + flatDirection.z() * frame.rayDistance
                );

                let ray = castBlockRay(
                    vehicle,
                    from,
                    to,
                    distance,
                    label,
                    frame.distanceFromRayStartToVehicleFront
                );

                rays.push(ray);

                if (ray.ratio < bestRatio) {
                    bestRatio = ray.ratio;
                }
            }
        }

        debugRayFan(vehicle, label, frame, rays, bestRatio);

        return {
            label: label,
            source: frame.source,
            ratio: clamp(bestRatio, 0.0, 1.0),
            rays: rays,
            frame: frame
        };
    }


    function debugRayFan(vehicle, label, frame, rays, bestRatio) {
        if (!DEBUG_DRIVING) return;
        if (vehicle.tickCount % DEBUG_EVERY_TICKS != 0) return;

        let blockedCount = 0;
        let errorCount = 0;
        let missCount = 0;
        let typeSample = "none";
        let errorSample = "";

        for (let ray of rays) {
            if (ray.blocked) blockedCount++;

            if (ray.typeName == "ERROR") {
                errorCount++;
                errorSample = ray.errorText;
            }

            if (String(ray.typeName).indexOf("MISS") >= 0) {
                missCount++;
            }

            typeSample = ray.typeName;
        }

        debugDriving(
            vehicle,
            `RAY ${label} src=${frame.source} rays=${rays.length} block=${blockedCount} miss=${missCount} err=${errorCount} ratio=${bestRatio.toFixed(2)} hf=${frame.halfForward.toFixed(2)} hw=${frame.halfWidth.toFixed(2)} type=${typeSample}`
        );

        if (errorCount > 0) {
            debugDriving(
                vehicle,
                `RAYERR ${String(errorSample).substring(0, 90)}`
            );
        }
    }


    function getRaySensorFrame(vehicle, flatDirection, probeDistance) {
        let collisionObb = getKubeCollisionOBB(vehicle);

        if (collisionObb != null) {
            return getCollisionObbRaySensorFrame(
                vehicle,
                collisionObb,
                flatDirection,
                probeDistance
            );
        }

        return getFallbackAabbRaySensorFrame(
            vehicle,
            flatDirection,
            probeDistance
        );
    }


    function getCollisionObbRaySensorFrame(vehicle, obb, flatDirection, probeDistance) {
        let center = vec3FromAny(obb.center);

        let ext = getObbExtents(obb);

        let ex = Math.abs(component(ext, "x"));
        let ey = Math.abs(component(ext, "y"));
        let ez = Math.abs(component(ext, "z"));

        let axes = obb.getAxes();

        let axisX = normalizeFlatDirection(vec3FromAny(getArrayLike(axes, 0)));
        let axisY = vec3FromAny(getArrayLike(axes, 1));
        let axisZ = normalizeFlatDirection(vec3FromAny(getArrayLike(axes, 2)));

        let rayDirection = normalizeFlatDirection(flatDirection);
        let sideAxis = getRightFromFlatDirection(rayDirection);

        // Support radius from center to the tested face in this exact direction.
        let halfForward =
            Math.abs(dotFlat(rayDirection, axisX)) * ex
            + Math.abs(dotFlat(rayDirection, axisZ)) * ez;

        let halfWidth =
            Math.abs(dotFlat(sideAxis, axisX)) * ex
            + Math.abs(dotFlat(sideAxis, axisZ)) * ez;

        let usableHalfWidth = Math.max(
            RAY_MIN_HALF_WIDTH,
            halfWidth + RAY_SIDE_MARGIN
        );

        let sideOffsets = [];

        for (let fraction of RAY_SIDE_FRACTIONS) {
            sideOffsets.push(usableHalfWidth * fraction);
        }

        let heightYs = [];

        for (let fraction of RAY_HEIGHT_FRACTIONS) {
            let localY = -ey + ey * 2.0 * fraction;

            let point = new $Vec3(
                center.x() + component(axisY, "x") * localY,
                center.y() + component(axisY, "y") * localY,
                center.z() + component(axisY, "z") * localY
            );

            heightYs.push(point.y());
        }

        // Center-start ray:
        // center -> tested face -> probe distance past tested face.
        let distanceFromRayStartToVehicleFace = Math.max(halfForward, 0.001);

        let rayDistance =
            distanceFromRayStartToVehicleFace
            + probeDistance
            + RAY_FRONT_END_EXTRA;

        return {
            source: "collisionObbCenter",
            box: null,
            center: center,
            rayStartCenter: center,
            right: sideAxis,
            sideOffsets: sideOffsets,
            heightYs: heightYs,
            rayDistance: rayDistance,
            distanceFromRayStartToVehicleFront: distanceFromRayStartToVehicleFace,
            halfForward: distanceFromRayStartToVehicleFace,
            halfWidth: usableHalfWidth
        };
    }


    function getFallbackAabbRaySensorFrame(vehicle, flatDirection, probeDistance) {
        let box = getBestVehicleSensorBox(vehicle);
        let center = box.getCenter();

        let rayDirection = normalizeFlatDirection(flatDirection);
        let sideAxis = getRightFromFlatDirection(rayDirection);

        let halfForward = Math.max(
            getAabbFlatLengthAlong(box, rayDirection) * 0.5,
            0.5
        );

        let halfWidth = Math.max(
            getAabbFlatLengthAlong(box, sideAxis) * 0.5,
            RAY_MIN_HALF_WIDTH
        );

        let sideOffsets = [];

        for (let fraction of RAY_SIDE_FRACTIONS) {
            sideOffsets.push((halfWidth + RAY_SIDE_MARGIN) * fraction);
        }

        let height = Math.max(box.maxY - box.minY, 1.0);
        let heightYs = [];

        for (let fraction of RAY_HEIGHT_FRACTIONS) {
            heightYs.push(box.minY + height * fraction);
        }

        let distanceFromRayStartToVehicleFace = Math.max(halfForward, 0.001);

        let rayDistance =
            distanceFromRayStartToVehicleFace
            + probeDistance
            + RAY_FRONT_END_EXTRA;

        return {
            source: "fallbackAabbCenter",
            box: box,
            center: center,
            rayStartCenter: center,
            right: sideAxis,
            sideOffsets: sideOffsets,
            heightYs: heightYs,
            rayDistance: rayDistance,
            distanceFromRayStartToVehicleFront: distanceFromRayStartToVehicleFace,
            halfForward: halfForward,
            halfWidth: halfWidth + RAY_SIDE_MARGIN
        };
    }


    function castBlockRay(vehicle, from, to, probeDistance, label, distanceFromRayStartToVehicleFace) {
        let hit = null;
        let ratio = 1.0;
        let blocked = false;
        let hitLocation = to;
        let typeName = "NO_HIT";
        let errorText = "";

        try {
            let context = new $ClipContext(
                from,
                to,
                "collider",
                "none",
                vehicle
            );

            hit = vehicle.level.clip(context);

            if (hit == null) {
                typeName = "NULL";
            } else {
                typeName = String(hit.getType());
            }

            if (hit != null && typeName.indexOf("MISS") < 0) {
                blocked = true;
                hitLocation = hit.getLocation();

                let hitDistanceFromRayStart = horizontalDistanceBetween(from, hitLocation);

                // Center-start math:
                // Anything before the tested face means the vehicle is already touching/overlapping
                // a block in that movement direction, so clearance is 0.
                let clearDistancePastFace =
                    hitDistanceFromRayStart - distanceFromRayStartToVehicleFace;

                if (probeDistance > 0.001) {
                    ratio = clamp(clearDistancePastFace / probeDistance, 0.0, 1.0);
                }

                if (clearDistancePastFace < 0.0) {
                    typeName = typeName + "_BEFORE_TESTED_FACE";
                }
            }
        } catch (error) {
            errorText = String(error);
            typeName = "ERROR";

            blocked = false;
            ratio = 1.0;
            hitLocation = to;
        }

        return {
            label: label,
            from: from,
            to: to,
            hit: hit,
            hitLocation: hitLocation,
            ratio: ratio,
            blocked: blocked,
            typeName: typeName,
            errorText: errorText
        };
    }


    function getKubeCollisionOBB(vehicle) {
        let cacheKey = getVehicleCacheKey(vehicle);
        let tick = vehicle.tickCount;

        let cached = SENSOR_OBB_CACHE[cacheKey];

        if (cached != null && cached.tick == tick) {
            return cached.obb;
        }

        let result = null;

        try {
            vehicle.updateOBB();
        } catch (error) {
        }

        let obbs = null;

        try {
            obbs = vehicle.getOBBs();
        } catch (error2) {
            SENSOR_OBB_CACHE[cacheKey] = {
                tick: tick,
                obb: null
            };

            return null;
        }

        if (obbs != null) {
            try {
                let iterator = obbs.iterator();

                while (iterator.hasNext()) {
                    let obb = iterator.next();

                    if (isCollisionOBB(obb)) {
                        result = obb;
                        break;
                    }
                }
            } catch (error3) {
                try {
                    for (let i = 0; i < obbs.length; i++) {
                        let obb = obbs[i];

                        if (isCollisionOBB(obb)) {
                            result = obb;
                            break;
                        }
                    }
                } catch (error4) {
                }
            }
        }

        SENSOR_OBB_CACHE[cacheKey] = {
            tick: tick,
            obb: result
        };

        return result;
    }


    function getVehicleCacheKey(vehicle) {
        try {
            return vehicle.getStringUuid();
        } catch (error) {
        }

        try {
            return String(vehicle.getUuid());
        } catch (error2) {
        }

        return String(vehicle.getId ? vehicle.getId() : vehicle);
    }


    function isCollisionOBB(obb) {
        if (obb == null) return false;

        try {
            let partText = String(obb.part).toUpperCase();

            return partText.indexOf("COLLISION") >= 0;
        } catch (error) {
        }

        return false;
    }


    function getBestVehicleSensorBox(vehicle) {
        // Sensor Core V2 uses this only as fallback.
        // The normal path should be the Collision OBB from vehicle.getOBBs().
        try {
            let obbs = vehicle.getOBBs();
            let iterator = obbs.iterator();

            let minX = 1.0e30;
            let minY = 1.0e30;
            let minZ = 1.0e30;
            let maxX = -1.0e30;
            let maxY = -1.0e30;
            let maxZ = -1.0e30;

            let found = false;

            while (iterator.hasNext()) {
                let obb = iterator.next();
                let vertices = obb.getVertices();

                for (let i = 0; i < vertices.length; i++) {
                    let v = vertices[i];

                    let x = component(v, "x");
                    let y = component(v, "y");
                    let z = component(v, "z");

                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    minZ = Math.min(minZ, z);

                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                    maxZ = Math.max(maxZ, z);

                    found = true;
                }
            }

            if (found) {
                return AABB.of(minX, minY, minZ, maxX, maxY, maxZ);
            }
        } catch (error) {
        }

        try {
            return $VehicleMotionUtils.INSTANCE.calculateCombinedAABBOptimized(vehicle);
        } catch (error2) {
        }

        try {
            return vehicle.getBoundingBox();
        } catch (error3) {
        }

        return vehicle.boundingBox;
    }


    function getObbExtents(obb) {
        try {
            return obb.extents();
        } catch (error) {
        }

        try {
            return obb.extents;
        } catch (error2) {
        }

        return null;
    }


    function getArrayLike(value, index) {
        if (value == null) return null;

        try {
            return value[index];
        } catch (error) {
        }

        try {
            return value.get(index);
        } catch (error2) {
        }

        return null;
    }


    function component(value, name) {
        if (value == null) return 0.0;

        try {
            let possibleFunction = value[name];

            if (typeof possibleFunction === "function") {
                return Number(possibleFunction.call(value));
            }
        } catch (error) {
        }

        try {
            return Number(value[name]);
        } catch (error2) {
        }

        return 0.0;
    }


    function vec3FromAny(value) {
        return new $Vec3(
            component(value, "x"),
            component(value, "y"),
            component(value, "z")
        );
    }


    function dotFlat(a, b) {
        return a.x() * b.x() + a.z() * b.z();
    }


    function getAabbFlatLengthAlong(aabb, flatDirection) {
        let xSize = aabb.maxX - aabb.minX;
        let zSize = aabb.maxZ - aabb.minZ;

        return Math.abs(flatDirection.x()) * xSize
            + Math.abs(flatDirection.z()) * zSize;
    }


    function getRightFromFlatDirection(flatDirection) {
        return new $Vec3(
            -flatDirection.z(),
            0.0,
            flatDirection.x()
        );
    }


    function drawMovementProbe(vehicle, probe) {
        if (!DEBUG_DRIVING) return;
        if (vehicle.tickCount % DEBUG_EVERY_TICKS != 0) return;

        for (let ray of probe.rays) {
            drawParticleLine(
                vehicle,
                ray.from,
                ray.to,
                ray.blocked ? "minecraft:flame" : "minecraft:end_rod",
                RAY_DEBUG_STEPS
            );

            if (ray.blocked) {
                vehicle.level.runCommandSilent(
                    `particle minecraft:flame ${ray.hitLocation.x()} ${ray.hitLocation.y()} ${ray.hitLocation.z()} 0 0 0 0 3 force`
                );
            } else {
                vehicle.level.runCommandSilent(
                    `particle minecraft:glow ${ray.to.x()} ${ray.to.y()} ${ray.to.z()} 0 0 0 0 1 force`
                );
            }
        }

        // Frame markers: center, ray start center, and final allowed-progress marker.
        if (probe.frame != null) {
            let center = probe.frame.center;
            let start = probe.frame.rayStartCenter;

            vehicle.level.runCommandSilent(
                `particle minecraft:happy_villager ${center.x()} ${center.y()} ${center.z()} 0 0 0 0 1 force`
            );

            vehicle.level.runCommandSilent(
                `particle minecraft:composter ${start.x()} ${start.y()} ${start.z()} 0 0 0 0 1 force`
            );
        }

        let from = new $Vec3(
            vehicle.getX(),
            vehicle.getY() + 0.75,
            vehicle.getZ()
        );

        let allowedTo = new $Vec3(
            from.x() + probe.allowed.x(),
            from.y() + probe.allowed.y(),
            from.z() + probe.allowed.z()
        );

        vehicle.level.runCommandSilent(
            `particle ${probe.blocked ? "minecraft:flame" : "minecraft:glow"} ${allowedTo.x()} ${allowedTo.y()} ${allowedTo.z()} 0 0 0 0 2 force`
        );
    }


    function drawParticleLine(vehicle, from, to, particle, steps) {
        for (let i = 0; i <= steps; i++) {
            let t = i / steps;

            let x = from.x() + (to.x() - from.x()) * t;
            let y = from.y() + (to.y() - from.y()) * t;
            let z = from.z() + (to.z() - from.z()) * t;

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
        if (diff < -TURN_ANGLE_THRESHOLD) {
            assistedLeft(vehicle);
        } else if (diff > TURN_ANGLE_THRESHOLD) {
            assistedRight(vehicle);
        } else {
            vehicle.setLeftInputDown(false);
            vehicle.setRightInputDown(false);
        }
    }


    function getAwayPositionFromEntity(vehicle, entity) {
        let vx = vehicle.getX();
        let vy = vehicle.getY();
        let vz = vehicle.getZ();

        let ex = entity.getX();
        let ez = entity.getZ();

        return new $Vec3(
            vx + (vx - ex),
            vy,
            vz + (vz - ez)
        );
    }


    function getVehicleHealthRatio(vehicle) {
        let health = getVehicleHealth(vehicle);
        let maxHealth = getVehicleMaxHealth(vehicle);

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

    function getVehicleFlatFront(vehicle) {
        let collisionObb = getKubeCollisionOBB(vehicle);

        if (collisionObb != null) {
            try {
                let axes = collisionObb.getAxes();
                let front = normalizeFlatDirection(vec3FromAny(getArrayLike(axes, 2)));

                if (horizontalLength(front) > 0.001) {
                    return front;
                }
            } catch (error) {
            }
        }

        try {
            let view = normalizeFlatDirection(vehicle.getViewVector(1.0));

            if (horizontalLength(view) > 0.001) {
                return view;
            }
        } catch (error2) {
        }

        return getFlatForward(vehicle);
    }


    function getFlatForward(vehicle) {
        try {
            let f = vehicle.getForwardDirection();

            let x = component(f, "x");
            let z = component(f, "z");

            let len = Math.sqrt(x * x + z * z);
            if (len >= 0.001) {
                return new $Vec3(x / len, 0.0, z / len);
            }
        } catch (error) {
        }

        return new $Vec3(0.0, 0.0, 1.0);
    }


    function getBackDirection(vehicle) {
        let f = getVehicleFlatFront(vehicle);

        return new $Vec3(
            -f.x(),
            0.0,
            -f.z()
        );
    }


    function getFlatRight(vehicle) {
        let f = getVehicleFlatFront(vehicle);

        return getRightFromFlatDirection(f);
    }


    function getFrontDiagonalDirection(vehicle, side) {
        let forward = getVehicleFlatFront(vehicle);
        let right = getRightFromFlatDirection(forward);

        let x = forward.x() + right.x() * side;
        let z = forward.z() + right.z() * side;

        let len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return forward;

        return new $Vec3(x / len, 0.0, z / len);
    }


    function normalizeFlatDirection(direction) {
        let x = component(direction, "x");
        let z = component(direction, "z");

        let len = Math.sqrt(x * x + z * z);
        if (len < 0.001) return new $Vec3(0.0, 0.0, 0.0);

        return new $Vec3(x / len, 0.0, z / len);
    }


    function getDiffToPosition(vehicle, pos) {
        let toPos = vehicle.position().vectorTo(pos).normalize();
        let vehicleVec = vehicle.getViewVector(1.0).normalize();

        return $Mth.wrapDegrees(
            -$VehicleVecUtils.getYRotFromVector(toPos)
            + $VehicleVecUtils.getYRotFromVector(vehicleVec)
        );
    }


    // -------------------------------------------------------------------------
    // Input helpers
    // -------------------------------------------------------------------------

    function steerTowardDiff(vehicle, diff, absDiff) {
        if (absDiff > TURN_ANGLE_THRESHOLD) {
            if (diff < -TURN_ANGLE_THRESHOLD) assistedLeft(vehicle);
            if (diff > TURN_ANGLE_THRESHOLD) assistedRight(vehicle);
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
        let turnDirection = getAvoidTurnDirection(vehicle);

        if (turnDirection > 0) {
            assistedRight(vehicle);
        } else {
            assistedLeft(vehicle);
        }
    }


    function getAvoidTurnDirection(vehicle) {
        let data = vehicle.getPersistentData();

        let direction = data.getInt("sbw_ai_avoid_turn_direction");

        if (direction == 0) {
            direction = 1; // 1 = right, -1 = left
            data.putInt("sbw_ai_avoid_turn_direction", direction);
        }

        return direction;
    }


    function flipAvoidTurnDirection(vehicle) {
        let data = vehicle.getPersistentData();

        let direction = getAvoidTurnDirection(vehicle);
        data.putInt("sbw_ai_avoid_turn_direction", -direction);
    }


    function startReverseAlign(vehicle) {
        let data = vehicle.getPersistentData();

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
        if (diff < -TURN_ANGLE_THRESHOLD) {
            assistedRight(vehicle);
        } else if (diff > TURN_ANGLE_THRESHOLD) {
            assistedLeft(vehicle);
        } else {
            vehicle.setLeftInputDown(false);
            vehicle.setRightInputDown(false);
        }
    }


    function canStartReverseAlign(vehicle) {
        let data = vehicle.getPersistentData();

        return data.getInt("sbw_ai_reverse_align_ticks") <= 0
            && data.getInt("sbw_ai_reverse_align_cooldown") <= 0;
    }


    function stopReverseAlign(vehicle) {
        let data = vehicle.getPersistentData();

        data.putInt("sbw_ai_reverse_align_ticks", 0);
    }


    function assistedCreepForward(vehicle) {
        let data = vehicle.getPersistentData();

        let creepTicks = data.getInt("sbw_ai_creep_forward_ticks");

        if (creepTicks > 0) {
            data.putInt("sbw_ai_creep_forward_ticks", creepTicks - 1);

            vehicle.setForwardInputDown(true);
            vehicle.setBackInputDown(false);

            return true;
        }

        let cooldown = data.getInt("sbw_ai_creep_forward_cooldown");

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
        let data = vehicle.getPersistentData();

        decrementTimer(data, "sbw_ai_reverse_align_cooldown");
        decrementTimer(data, "sbw_ai_creep_forward_cooldown");
    }


    function decrementTimer(data, key) {
        let value = data.getInt(key);

        if (value > 0) {
            data.putInt(key, value - 1);
        }
    }


    function updateFrontBlockedTicks(vehicle, frontBlocked) {
        let data = vehicle.getPersistentData();

        if (!frontBlocked) {
            data.putInt("sbw_ai_front_blocked_ticks", 0);
            return 0;
        }

        let ticks = data.getInt("sbw_ai_front_blocked_ticks") + 1;
        data.putInt("sbw_ai_front_blocked_ticks", ticks);

        return ticks;
    }

    function updateStuckTicks(vehicle, wantedToMove) {
        let data = vehicle.getPersistentData();

        if (!wantedToMove) {
            data.putInt("sbw_ai_stuck_ticks", 0);
            return 0;
        }

        let speed = getHorizontalSpeed(vehicle);

        let minimumMovingSpeed = 0.06;

        if (speed < minimumMovingSpeed) {
            let stuckTicks = data.getInt("sbw_ai_stuck_ticks") + 1;
            data.putInt("sbw_ai_stuck_ticks", stuckTicks);
            return stuckTicks;
        }

        data.putInt("sbw_ai_stuck_ticks", 0);
        return 0;
    }


    function updateRecoveryCooldown(vehicle) {
        let data = vehicle.getPersistentData();

        let cooldown = data.getInt("sbw_ai_collision_recovery");

        if (cooldown > 0) {
            data.putInt("sbw_ai_collision_recovery", cooldown - 1);
        }
    }


    function isVehicleCollidingThisTick(vehicle) {
        return vehicle.horizontalCollision;
    }


    function startCollisionRecovery(vehicle) {
        let data = vehicle.getPersistentData();

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
        let x = vec.x();
        let z = vec.z();

        return Math.sqrt(x * x + z * z);
    }


    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function horizontalDistanceBetween(a, b) {
        let x = b.x() - a.x();
        let z = b.z() - a.z();

        return Math.sqrt(x * x + z * z);
    }


    function getHorizontalSpeed(vehicle) {
        let movement = vehicle.getDeltaMovement();

        let x = movement.x();
        let z = movement.z();

        return Math.sqrt(x * x + z * z);
    }


})();
