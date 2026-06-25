// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare


(() => {
    const { $ItemFrame, $GlowItemFrame } = require("@package/net/minecraft/world/entity/decoration");
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

    const RAY_CAST_RESOLUTION = 45;
    const RAY_DIRECTIONS = ["front", "right", "back", "left"];
    const DEFAULT_PARTICLE = "minecraft:crit"

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


        // Optimized Bounding Box
        function getOptimizedBoundingBox() {

            if (!vehicle.enableAABB()) {
                var obbList = vehicle.getOBBs()


                var min = new $Vector3d($Double.MAX_VALUE, $Double.MAX_VALUE, $Double.MAX_VALUE)
                var max = new $Vector3d(-$Double.MAX_VALUE, -$Double.MAX_VALUE, -$Double.MAX_VALUE)

                // Incorperate vehicle bounding box
                min = vehicle.getBoundingBox().getMinPosition();
                max = vehicle.getBoundingBox().getMaxPosition();

                obbList.forEach((obb) => {
                    var center = obb.center;
                    var vertices = obb.getVertices();
                    var axes = obb.getAxes();
                    var rotation = obb.rotation();

                    vertices.forEach((vertex) => {

                        var minx = Math.min(min.x(), Math.sin(rotation.x()) + vertex.x());
                        var miny = Math.min(min.y(), Math.cos(rotation.y()) + vertex.y());
                        var minz = Math.min(min.z(), Math.sin(rotation.z()) + vertex.z());

                        var maxx = Math.max(max.x(), Math.sin(rotation.x()) + vertex.x());
                        var maxy = Math.max(max.y(), Math.cos(rotation.y()) + vertex.y());
                        var maxz = Math.max(max.z(), Math.sin(rotation.z()) + vertex.z());

                        min = new $Vector3d(minx, miny, minz);
                        max = new $Vector3d(maxx, maxy, maxz);
                    });
                });

                return new $AABB($OBB.vector3dToVec3(min), $OBB.vector3dToVec3(max));
            } else {
                return vehicle.getBoundingBox();
            }

        };


        let vehicleAABB = getOptimizedBoundingBox();
        let vehicleStepHeight = vehicle.maxUpStep();

        const directionData = new Map([
            ["", { particle: DEFAULT_PARTICLE, rayData: [], blockedRays: 0, raysPerDirection: 0 }],
            ["front", { particle: "minecraft:flame", rayData: [], blockedRays: 0, raysPerDirection: 0 }],
            ["right", { particle: "minecraft:glow", rayData: [], blockedRays: 0, raysPerDirection: 0 }],
            ["back", { particle: "minecraft:soul_fire_flame", rayData: [], blockedRays: 0, raysPerDirection: 0 }],
            ["left", { particle: "minecraft:happy_villager", rayData: [], blockedRays: 0, raysPerDirection: 0 }],
        ]);


        /** 
         * Gets a vector from the vehicle center to the degree that is NOT affected by the vehicleAABB size and center
         * Needs the vehicle forward direction to keep left, right, front, back consistent
         * @param {$Vec3} vehicleRotation 
         * @param {number} startingDegree - The degree to start from
         * @param {number} endingDegree - The degree to end at
         */
        function getClipDegreeVector(vehicleRotation, startingDegree, endingDegree) {
            return $Vec3.directionFromRotation(vehicleRotation.x, (vehicleRotation.y + startingDegree) + endingDegree);
        }


        /**
         * Gets the block hit result from the clip context
         * @param {$Vec3} from Clip begin
         * @param {$Vec3} to Clip end
         * @param {import("@package/net/minecraft/world/level").$ClipContext$Block_} clipBlock Clip block 
         * @param {import("@package/net/minecraft/world/level").$ClipContext$Fluid_} clipFluid Clip fluid
         * @param {$Entity} entity The entity the clip context is for
         */
        function getClipContext(from, to, clipBlock, clipFluid, entity) {
            return new $ClipContext(from, to, clipBlock, clipFluid, entity);
        }



        /**
         * Returns a left, right, front, back direciton string
         * @param {number} degree
         */
        function getDegreeToString(degree) {
            var wrapOnFront = (degree + 180) % 360;
            let offset = 45;

            // Front
            if (wrapOnFront >= 90 + offset && wrapOnFront <= 180 + offset) {
                return RAY_DIRECTIONS[0];
            }

            // Back
            if (degree >= 90 + offset && degree <= 180 + offset) {
                return RAY_DIRECTIONS[2];
            }

            // Left
            if (degree > 180 + offset && degree < 360 + offset) {
                return RAY_DIRECTIONS[3];
            }

            // Right
            if (degree > 0 + offset && degree < 180 + offset) {
                return RAY_DIRECTIONS[1];
            }
        }


        /**
         * Gets the clip context pointing to the degree this is scaled to the vehicleAABB 
         * @param {number} degree
         */
        function getClipContextToDegrees(degree) {
            var stepheightVector = vehicleAABB.getBottomCenter().add(0, vehicleStepHeight / 2, 0);
            var clipDegreeVector = getClipDegreeVector(vehicle.getRotationVector(), 0, degree).scale(vehicleAABB.getSize()).add(stepheightVector);
            var clipContext = getClipContext(stepheightVector, clipDegreeVector, "collider", "none", vehicle);
            return { "clipContext": clipContext, "clipDegreeVector": clipDegreeVector, "stepheightVector": stepheightVector };
        }


        // Intial Calculations
        for (let degree = 0; degree < 360; degree += RAY_CAST_RESOLUTION) {
            var ClipContextToDegrees = getClipContextToDegrees(degree);
            var { clipContext, clipDegreeVector, stepheightVector } = ClipContextToDegrees;
            var blockHitResult = vehicle.level.clip(clipContext);
            var blockHitLocation = blockHitResult.getLocation();

            var direction = getDegreeToString(degree);
            var type = blockHitResult.getType();
            var perDirData = directionData.get(direction || "");

            // Update blocked rays
            if (type != "MISS") {
                // Update blocked ratio
                perDirData.blockedRays += 1;
            }

            // Update rays per direction
            perDirData.raysPerDirection += 1;
            perDirData.rayData[degree] = {
                "ClipContextToDegrees": ClipContextToDegrees,
            }

            if (type != "MISS") {
                // Update blocked ratio
                drawParticle(perDirData.particle, vehicle, blockHitLocation.x(), blockHitLocation.y(), blockHitLocation.z());
            } else {
                drawParticle(DEFAULT_PARTICLE, vehicle, blockHitLocation.x(), blockHitLocation.y(), blockHitLocation.z());
            }

        }


        // Secondary Actoins
        directionData.forEach((perDirData, direction) => {

            var blockedRays = perDirData.blockedRays;
            var raysPerDirection = perDirData.raysPerDirection;
            // perDirData.rayData.forEach((rayData, degree) => {
            //     var { clipContext, clipDegreeVector, stepheightVector } = rayData.ClipContextToDegrees;
            //     var maxDistance = clipContext.getTo().distanceTo(clipContext.getFrom());
            //     var blockHitResult = vehicle.level.clip(clipContext);
            //     var blockHitLocation = blockHitResult.getLocation();
            //     var drivability = 1 - (blockedRays / raysPerDirection);
            //     var DistAABB = vehicleAABB.distanceToSqr(blockHitLocation);
            //     var someDiff = (degree + 45) % 360;
            //     drivability = drivability * DistAABB;
            //     var type = blockHitResult.getType();

            //     if (type == "MISS") return;
            //     if (type != "MISS") debugDriving(vehicle, `Drivability: ${drivability} Degree: ${degree} Direction: ${direction} Angle: ${someDiff < 90 && someDiff > 270}`);
            //     if (type != "MISS") {

            //         if (drivability) {
            //             vehicle.setLeftInputDown(degree < 180);
            //             vehicle.setRightInputDown(degree > 180);
            //         } else {
            //             if (degree > 180) vehicle.setLeftInputDown(false);
            //             if (degree < 180) vehicle.setRightInputDown(false);
            //         }
            //     }
            // });

            // Path is not obstructed
            if (blockedRays == 0) return;

            // The compounded drivability/confidence of all rays in this direction
            var pathConfidence = 1 - (blockedRays / raysPerDirection);

            // Get obstructed degrees
            let degreeData = perDirData.rayData.map((rayData, degree) => {
                var { clipContext, clipDegreeVector, stepheightVector } = rayData.ClipContextToDegrees;
                var blockHitResult = vehicle.level.clip(clipContext);
                var type = blockHitResult.getType();
                var blockHitLocation = blockHitResult.getLocation();
                var maxDistance = vehicleAABB.distanceToSqr(clipContext.getTo());
                var degreeDrivability = vehicleAABB.distanceToSqr(blockHitLocation) / maxDistance;
                pathConfidence *= degreeDrivability;

                // Collect data on obstructed degrees
                return { "degree": degree, "degreeDrivability": degreeDrivability, "to": clipContext.getTo(), "from": clipContext.getFrom(), "type": type };

            }).filter((v) => v);


            // Determine degree to drive towards
            var driveDegree = degreeData.sort((prev, curr) => {
                return (curr.degreeDrivability - prev.degreeDrivability) || (curr.from.distanceToSqr(curr.to) - prev.from.distanceToSqr(prev.to));
            })[0].degree;


            debugDriving(vehicle, `Direction ${direction} Confidence: ${pathConfidence} DriveDegree: ${driveDegree} DegreeData: ${degreeData.map((v) => `${v.degree}: ${v.degreeDrivability}`)}`);

        });

        // if (vehicle.tickCount % 60 !== 0) $TestTool.renderAABBEdgesWithParticles(vehicle.level, vehicleAABB, "minecraft:flame", 1, false)

    }

    EntityEvents.spawned((e) => {

        if (((e.getEntity().isFrame()) || (e.getEntity() instanceof $GlowItemFrame))) {
            e.getLevel().runCommandSilent(`kill @e[type=minecraft:glow_item_frame]`);
            e.getLevel().runCommandSilent(`kill @e[type=minecraft:item_frame]`);
            e.cancel();
        }
    })


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
