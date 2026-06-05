// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare

(() => {

    // kubejs/server_scripts/SuperbDrivingAssistance.js
    const DEBUG_DRIVING = true;
    const DEBUG_EVERY_TICKS = 5;
    
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
        const target = driver.getTarget ? driver.getTarget() : null;

        const vbox = getVehicleAABB(vehicle);
        const direction = vehicle.getForwardDirection();
        const forward = vbox.move(direction.x(), direction.y(), direction.z());

        drawBox(vehicle, vbox);
        if (!(target instanceof $LivingEntity)) return;

        updateRecoveryCooldown(vehicle);

        const diff = getDiffToPosition(vehicle, target.position());
        const absDiff = Math.abs(diff);

        // Always turn toward target.
        steerTowardDiff(vehicle, diff, absDiff);

        const followRange = driver.getAttributeValue("minecraft:generic.follow_range");
        const distance = vehicle.distanceToEntity(target);

        assistedDrive(vehicle, distance, followRange, diff, absDiff);
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

        // Deliberate reverse-align duration.
        // 20 ticks = about 1 second.
        data.putInt("sbw_ai_reverse_align_ticks", 20);
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

        let reverseTicks = data.getInt("sbw_ai_reverse_ticks");
        let reverseAlignTicks = data.getInt("sbw_ai_reverse_align_ticks");

        if (reverseAlignTicks > 0) {
            data.putInt("sbw_ai_reverse_align_ticks", reverseAlignTicks - 1);

            applyReverseAlign(vehicle, diff);

            updateStuckTicks(vehicle, true);
            return true;
        }

        const frontBlocked = isFrontRayBlocked(vehicle);
        const collision = isVehicleCollidingThisTick(vehicle);
        const speed = getHorizontalSpeed(vehicle);

        const driveState = getDriveAlignmentState(absDiff);

        debugDriving(
            vehicle,
            `state=${driveState} diff=${diff.toFixed(1)} front=${frontBlocked} speed=${speed.toFixed(2)} reverse=${reverseTicks} align=${reverseAlignTicks} stuck=${data.getInt("sbw_ai_stuck_ticks")}`
        );

        if (distance > followRange * 0.6) {
            reverseTicks = 0;
            data.putInt("sbw_ai_reverse_ticks", 0);
            data.putInt("sbw_ai_stuck_ticks", 0);
        }

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

            // If we have been blocked in front for a bit,
            // back up while turning toward the chosen open side.
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
            startReverseAlign(vehicle);
            applyReverseAlign(vehicle, diff);

            updateStuckTicks(vehicle, true);
            return true;
        }

        if (driveState == "TURN_ONLY") {
            // Small controlled movement so steering can actually affect the vehicle.
            vehicle.setForwardInputDown(false);
            vehicle.setBackInputDown(true);

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

    /** @param {$VehicleEntity} vehicle */
    function getVehicleAABB(vehicle) {
        var deltaMovement = vehicle.getDeltaMovement();
        var aabb = $VehicleMotionUtils.INSTANCE.calculateCombinedAABBOptimized(vehicle)
            .inflate(0.25, 0.0, 0.25)
            .move(deltaMovement.x(), deltaMovement.y(), deltaMovement.z())
            .move(0.0, 0.5, 0.0)
        return aabb;
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
