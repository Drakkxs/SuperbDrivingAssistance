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
    const { $LivingEntity, $Entity } = require("@package/net/minecraft/world/entity");
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

        /** 
         * Gets a vector from the vehicle center to the angle that is NOT affected by the vehicleAABB size and center
         * Needs the vehicle forward direction to keep left, right, front, back consistent
         * @param {$Vec3} vehicleRotation 
         * @param {number} startingAngle 
         * @param {number} endingAngle
         */
        function getClipAngleVector(vehicleRotation, startingAngle, endingAngle) {
            return $Vec3.directionFromRotation(vehicleRotation.x, (vehicleRotation.y + startingAngle) + endingAngle);
        }


        /**
         * Gets the block hit result from the clip context
         * @param {$Vec3} to Clip begin
         * @param {$Vec3} from Clip end
         * @param {import("@package/net/minecraft/world/level").$ClipContext$Block_} clipBlock Clip block 
         * @param {import("@package/net/minecraft/world/level").$ClipContext$Fluid_} clipFluid Clip fluid
         * @param {$Entity} entity The entity the clip context is for
         */
        function getClipContext(to, from, clipBlock, clipFluid, entity) {
            return new $ClipContext(to, from, clipBlock, clipFluid, entity);
        }

        obbList.forEach((obb) => {
            obbThing(obb)
        });

        let vehicleAABB = new $AABB($OBB.vector3dToVec3(min), $OBB.vector3dToVec3(max));
        let vehicleStepHeight = vehicle.maxUpStep();

        let clipAngles = [-90, 90, -180, 180]; // Front, Back, Left, Right
        let clipAngleVectors = clipAngles.map((angle) => {
            return getClipAngleVector(vehicle.getRotationVector(), 0, angle).scale(vehicleAABB.getSize()).add(vehicleAABB.getCenter());
        });

        // for (let clipAngleVector of clipAngleVectors) {
        for (let angle = 0; angle <= 360; angle += 5) {
            var stepheightVector = vehicleAABB.getBottomCenter().add(0, vehicleStepHeight / 2, 0);
            var clipAngleVector = getClipAngleVector(vehicle.getRotationVector(), 0, angle).scale(vehicleAABB.getSize()).add(stepheightVector);
            var clipContext = getClipContext(stepheightVector, clipAngleVector, "collider", "none", vehicle);
            var blockHitResult = vehicle.level.clip(clipContext);
            var blockHitLocation = blockHitResult.getLocation();
            drawParticle("minecraft:glow", vehicle, blockHitLocation.x(), blockHitLocation.y(), blockHitLocation.z());
            if (blockHitResult.getType() != "MISS") {
                debugDriving(vehicle, `Hit: ${blockHitResult.getType()} Angle: ${angle} DistanceTo ${vehicle.distanceTo(blockHitLocation) / 100}`);
            }
        }

        // if (vehicle.tickCount % 60 !== 0) $TestTool.renderAABBEdgesWithParticles(vehicle.level, vehicleAABB, "minecraft:flame", 1, false)

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

})();
