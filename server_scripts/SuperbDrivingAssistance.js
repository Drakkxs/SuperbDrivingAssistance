// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare

(() => {

    const { $Double } = require("@package/java/lang");
    const { $Vector3d, $Vector2d } = require("@package/org/joml");
    const { $OBB, $TestTool, $OBB$Part } = require("@package/com/atsuishio/superbwarfare/tools");
    const { $ClipContext, $ClipContext$Block, $ClipContext$Fluid, $ClipContext$ShapeGetter } = require("@package/net/minecraft/world/level");
    const { $UUID } = require("@package/java/util");
    const { $Player } = require("@package/net/minecraft/world/entity/player");
    const { $PlayerInteractEvent$EntityInteract } = require("@package/net/neoforged/neoforge/event/entity/player");
    const { $EntityTickEvent$Pre } = require("@package/net/neoforged/neoforge/event/tick");
    const { $VehicleEntity } = require("@package/com/atsuishio/superbwarfare/entity/vehicle/base");
    const { $VehicleVecUtils, $VehicleMotionUtils } = require("@package/com/atsuishio/superbwarfare/entity/vehicle/utils");
    const { $Monster } = require("@package/net/minecraft/world/entity/monster");
    const { $LivingEntity } = require("@package/net/minecraft/world/entity");
    const { $Mth } = require("@package/net/minecraft/util");
    const { $Vec3, $AABB } = require("@package/net/minecraft/world/phys");

    // Utility used to place vehicles into the vehicle passangers.
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
        if (driver.level.isClientSide()) return;

        let vehicle = driver.getVehicle();

        if (vehicle == null) return;
        if (!(vehicle instanceof $VehicleEntity)) return;
        if (vehicle.getFirstPassenger() != driver) return;

        vehicle.getPersistentData().putBoolean("sbw_ai_is_hostile", (driver instanceof $Monster));

        tickVehicle(vehicle, driver);
    });

    /**
     * ticks the vehicle
     * @param {$VehicleEntity} vehicle 
     * @param {$LivingEntity} driver 
     */
    function tickVehicle(vehicle, driver) {

        if (vehicle.enableAABB()) return;

        let obbList = vehicle.getOBBs()


        let min = new $Vector3d($Double.MAX_VALUE, $Double.MAX_VALUE, $Double.MAX_VALUE)
        let max = new $Vector3d(-$Double.MAX_VALUE, -$Double.MAX_VALUE, -$Double.MAX_VALUE)
        let vehicleYaw = vehicle.getYaw(1);

        // Incorperate vehicle bounding box
        min = vehicle.getBoundingBox().getMinPosition();
        max = vehicle.getBoundingBox().getMaxPosition();

        /** @param {$OBB} obb */
        function obbThing(obb) {
            let center = obb.center;
            let vertices = obb.getVertices();
            let axes = obb.getAxes();
            let rotation = obb.rotation();

            vertices.forEach((vertex) => {

                let minx = Math.min(min.x(), Math.sin(rotation.x()) + vertex.x());
                let miny = Math.min(min.y(), Math.cos(rotation.y()) + vertex.y());
                let minz = Math.min(min.z(), Math.sin(rotation.z()) + vertex.z());

                let maxx = Math.max(max.x(), Math.sin(rotation.x()) + vertex.x());
                let maxy = Math.max(max.y(), Math.cos(rotation.y()) + vertex.y());
                let maxz = Math.max(max.z(), Math.sin(rotation.z()) + vertex.z());

                min = new $Vector3d(minx, miny, minz);
                max = new $Vector3d(maxx, maxy, maxz);
            });
        }

        obbList.forEach((obb) => {
            obbThing(obb)
        });

        let vehicleLocation = vehicle.position();
        let viewVector = vehicle.getViewVector(1.0).normalize();
        let deltaMovement = vehicle.getDeltaMovement().normalize();
        let vehicleAABB = new $AABB($OBB.vector3dToVec3(min), $OBB.vector3dToVec3(max));

        let direction_right = Math.cos(vehicleYaw * Math.PI / 180);
        let direction_left = Math.sin((vehicleYaw * Math.PI / 180));
        let direction_forward = Math.cos(vehicleYaw * Math.PI / 180);
        let direction_backward = Math.sin((vehicleYaw * Math.PI / 180));

        let forwardDireciton = new $Vec3(vehicle.getForwardDirection());
        let clipContenxtScale = vehicleAABB.getSize() * 2
        // let toClipContextDeltascale = vehicleAABB.getCenter().add(deltaMovement.scale(clipContenxtScale));
        let toClipContextForwardDirectionScale = vehicleAABB.getCenter().add(forwardDireciton.scale(clipContenxtScale));
        let toClipContextViewVectorScale = vehicleAABB.getCenter().add(viewVector.scale(clipContenxtScale));
        let fromClipContext = vehicleAABB.getCenter();



        /** 
         * Gets a vector from the vehicle center to the angle that is NOT affected by the vehicleAABB size and center
         * Needs the vehicle forward direction to keep left, right, front, back consistent
         * 
         */
        function sendClipToAngle(vehicleRotation, startingAngle, endingAngle) {
            // return center.add(direction.x(), 0, direction.z());
            // return new $Vec3(direction_backward, 0, direction_forward);
            // let rotation = vehicle.getRotationVector();
            // return $Vec3.directionFromRotation(rotation.x, (rotation.y + 90) + (0 % 90)).scale(vehicleAABB.getSize()).add(vehicleAABB.getCenter());
            return $Vec3.directionFromRotation(vehicleRotation.x, (vehicleRotation.y + startingAngle) + endingAngle);
        }

        let checkspot = sendClipToAngle(vehicle.getRotationVector(), 0, (vehicle.tickCount % 360)).scale(vehicleAABB.getSize()).add(vehicleAABB.getCenter());


        // // Front and Back
        // let isClipFront = ($Mth.floorDiv(vehicle.tickCount, 8) % 2 == 0);

        // // Diagonal Left and Right
        // let isClipLeft = ($Mth.floorDiv(vehicle.tickCount, 2) % 2 == 0);
        // let isClipLeft = isClipFront

        // /** @param {$Vec3} vecSource  */
        // function getClipFBInstance(vecSource, vecScale) {
        //     // return isClipFront ? vec : vec.add(direction_backward, 0, direction_forward);
        //     // return vec.zRot(isClipFront ? 0 : 180);
        //     return isClipFront ? vecSource.add(vecScale) : vecSource.subtract(vecScale);
        // }

        // Left and Right
        // function getClipLFRInstance(vecSource, vecScale) {
        //     return isClipLeft ? vecSource.add(vecScale) : vecSource.subtract(vecScale);
        // }

        // // Front and Back
        // let clipContextFB = new $ClipContext(
        //     fromClipContext,
        //     // toClipContextDeltascale,
        //     getClipFBInstance(vehicleAABB.getCenter(), forwardDireciton.scale(clipContenxtScale)),
        //     "collider",
        //     "none",
        //     vehicle
        // );

        // // Diagonal Left and Right
        // let widthSearchVectorScale = new $Vec3(direction_right * vehicleAABB.getSize(), 0, direction_left * vehicleAABB.getSize());



        // // Diagonal Left and Right
        // let clipContextLR = new $ClipContext(
        //     fromClipContext,

        //     getClipLFRInstance(getClipFBInstance(vehicleAABB.getCenter(), forwardDireciton.scale(clipContenxtScale)), widthSearchVectorScale),
        //     "collider",
        //     "none",
        //     vehicle
        // );

        // // Left and Right
        // let leftRightVector = new $Vec3(direction_right, 0, direction_left);

        // // Straight Left and Right
        // let clipContextSLR = new $ClipContext(
        //     fromClipContext,
        //     // isClipLeft ? vehicleAABB.getCenter().add(leftRightVector).add(widthSearchVectorScale) : vehicleAABB.getCenter().subtract(leftRightVector).subtract(widthSearchVectorScale),
        //     getClipLFRInstance(fromClipContext, leftRightVector.add(widthSearchVectorScale)),
        //     "collider",
        //     "none",
        //     vehicle
        // );


        // // Front and Back
        // let blockHitResultFB = vehicle.level.clip(clipContextFB)
        // let blockLocationFB = blockHitResultFB.getLocation();

        // // Diagonal Left and Right
        // let blockHitResultLR = vehicle.level.clip(clipContextLR)
        // let blockLocationLR = blockHitResultLR.getLocation();

        // // Straight Left and Right
        // let blockHitResultSLR = vehicle.level.clip(clipContextSLR)
        // let blockLocationSLR = blockHitResultSLR.getLocation();

        // let isClipFront = Math.abs(getDiffToPosition(vehicle, blockLocationFB)) < 90

        // debugDriving(vehicle,
        //     `Blocked Checks: ${isClipLeft ? "DL" : "DR"
        //     } ${blockHitResultLR.getType()} ${isClipFront ? "F" : "B"
        //     }: ${blockHitResultFB.getType()} ${isClipLeft ? "SL" : "SR"
        //     }: ${blockHitResultSLR.getType()}`
        // );

        // debugDriving(vehicle,
        //     `forwardDireciton: ${forwardDireciton} deltaMovement: ${deltaMovement}`
        // )

        // drawParticle("minecraft:end_rod", vehicle, vehicleAABB.getCenter().x(), vehicleAABB.getCenter().y(), vehicleAABB.getCenter().z())


        // // Front and Back
        // drawParticle("minecraft:glow", vehicle, blockLocationFB.x(), blockLocationFB.y(), blockLocationFB.z())
        // // Diagonal Left and Right
        // drawParticle("minecraft:soul_fire_flame", vehicle, blockLocationLR.x(), blockLocationLR.y(), blockLocationLR.z())

        // // Straight Left and Right
        // drawParticle("minecraft:happy_villager", vehicle, blockLocationSLR.x(), blockLocationSLR.y(), blockLocationSLR.z())

        // Checkspot
        drawParticle("minecraft:flame", vehicle, checkspot.x(), checkspot.y(), checkspot.z())
        debugDriving(vehicle, `Checkspot: ${checkspot} Forward: ${forwardDireciton}`)

        // debugDriving(vehicle, `Vehicle Right: ${right} Left: ${left} Width: ${width}`)
        // if (vehicle.tickCount % 60 !== 0) $TestTool.renderAABBEdgesWithParticles(vehicle.level, vehicleAABB, "minecraft:flame", 1, false)

    }

    /**
     * Draws a AABB
     * @param {string} particle
     * @param {$VehcileEntity} vehicle
     * @param {$AABB} aabb
     */
    function drawAABB(particle, vehicle, aabb) {
        let center = aabb.getCenter()
        let max = aabb.getMaxPosition()
        let min = aabb.getMinPosition()
        drawParticle(particle, vehicle, max.x(), max.y(), max.z())
        drawParticle(particle, vehicle, min.x(), min.y(), min.z())
    }

    /**
     * 
     * @param {$VehicleEntity} vehicle 
     * @param {string} message 
     * @returns 
     */
    function debugDriving(vehicle, message) {
        if (vehicle.tickCount % 5 != 0) return;
        vehicle.level.runCommandSilent(
            `title @a actionbar {"text":"[SDA] ${message}","color":"yellow"}`
        );
    }

    /** 
     * Draws a particle from the vehicle
     * @param {string} particle
     * @param {$VehicleEntity} vehicle 
     * @param {number} x
     * @param {number} y
     * @param {number} z 
     */
    function drawParticle(particle, vehicle, x, y, z) {
        vehicle.getLevel().runCommandSilent(
            `particle ${particle} ${x} ${y} ${z} 0 0 0 0 1 force`
        );
    }

    /**
     * Turns a vector to a yaw
     * @param {$VehicleEntity} vehicle 
     * @param {$Vec3} pos 
     */
    function getDiffToPosition(vehicle, pos) {
        let toPos = vehicle.position().vectorTo(pos).normalize();
        let vehicleVec = vehicle.getViewVector(1.0).normalize();

        return $Mth.wrapDegrees(
            -$VehicleVecUtils.getYRotFromVector(toPos)
            + $VehicleVecUtils.getYRotFromVector(vehicleVec)
        );
    }

})();
