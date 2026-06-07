// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare

(() => {

    const { $Double } = require("@package/java/lang");
    const { $Vector3d } = require("@package/org/joml");
    const { $OBB, $TestTool } = require("@package/com/atsuishio/superbwarfare/tools");
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
     * Sets all driving inputs to false
     * @param {$VehicleEntity} vehicle 
     */
    function prepareVehicleInputs(vehicle) {
        vehicle.setBackInputDown(false)
        vehicle.setForwardInputDown(false)
        vehicle.setLeftInputDown(false)
        vehicle.setRightInputDown(false)
    }

    /**
     * ticks the vehicle
     * @param {$VehicleEntity} vehicle 
     * @param {$LivingEntity} driver 
     */
    function tickVehicle(vehicle, driver) {

        // let OBBs = vehicle.getOBBs();
        // let obbBOX = {
        //     center: OBBs.getFirst().center,
        //     min: $Vector3d($Double.MAX_VALUE, $Double.MAX_VALUE, $Double.MAX_VALUE),
        //     max: $Vector3d(-$Double.MAX_VALUE, -$Double.MAX_VALUE, -$Double.MAX_VALUE)
        // }

        // OBBs.forEach((OBB) => {
        //     var pos = OBB.center
        //     obbBOX.max = obbBOX.max.max(pos)
        //     obbBOX.min = obbBOX.min.min(pos)

        //     obbBOX.center.half(obbBOX.max, obbBOX.min)
        // })

        if (vehicle.enableAABB()) return;

        let obbList = vehicle.getOBBs()

        // let min = new $Vector3d($Double.MAX_VALUE, $Double.MAX_VALUE, $Double.MAX_VALUE)
        // let max = new $Vector3d(-$Double.MAX_VALUE, -$Double.MAX_VALUE, -$Double.MAX_VALUE)

        let min = new $Vector3d($Double.MAX_VALUE, $Double.MAX_VALUE, $Double.MAX_VALUE)
        let max = new $Vector3d(-$Double.MAX_VALUE, -$Double.MAX_VALUE, -$Double.MAX_VALUE)


        // if (vehicle.tickCount % 10 !== 0) vehicle.level.runCommandSilent(`execute at ${vehicle.getStringUuid()} run teleport ${vehicle.getStringUuid()} ~ ~ ~ ${vehicle.tickCount} 0`)



        /** @param {$OBB} obb */
        function obbThing(obb) {
            let center = obb.center
            let vertices = obb.getVertices()
            let axes = obb.getAxes()
            let rotation = obb.rotation()

            // drawParticle("minecraft:glow", vehicle, center.x(), center.y(), center.z())
            vertices.forEach((vertex) => {
                // let minx = Math.min(min.x(), Math.sin(rotation.x()) + vertex.x())
                // let miny = Math.min(min.y(), Math.cos(rotation.y()) + vertex.y())
                // let minz = Math.min(min.z(), Math.sin(rotation.z()) + vertex.z())

                // let maxx = Math.max(max.x(), Math.sin(rotation.x()) + vertex.x())
                // let maxy = Math.max(max.y(), Math.cos(rotation.y()) + vertex.y())
                // let maxz = Math.max(max.z(), Math.sin(rotation.z()) + vertex.z())


                let minx = Math.min(min.x(), Math.sin(rotation.x()) + vertex.x())
                let miny = Math.min(min.y(), Math.cos(rotation.y()) + vertex.y())
                let minz = Math.min(min.z(), Math.sin(rotation.z()) + vertex.z())

                let maxx = Math.max(max.x(), Math.sin(rotation.x()) + vertex.x())
                let maxy = Math.max(max.y(), Math.cos(rotation.y()) + vertex.y())
                let maxz = Math.max(max.z(), Math.sin(rotation.z()) + vertex.z())
                // // drawParticle("minecraft:end_rod", vehicle, vertex.x(), vertex.y(), vertex.z())
                // min.x = Math.min(min.x, (vertex.x() + rotation.x()))
                // min.y = Math.min(min.y, (vertex.y() + rotation.y()))
                // min.z = Math.min(min.z, (vertex.z() + rotation.z()))

                // max.x = Math.max(max.x, (vertex.x() + rotation.x()))
                // max.y = Math.max(max.y, (vertex.y() + rotation.y()))
                // max.z = Math.max(max.z, (vertex.z() + rotation.z()))

                min = new $Vector3d(minx, miny, minz)
                max = new $Vector3d(maxx, maxy, maxz)
            });
        }

        // obbThing(obbList.getFirst())
        obbList.forEach((obb) => {
            obbThing(obb)
        });

        let postion = vehicle.position()
        let aabb = new $AABB($OBB.vector3dToVec3(min), $OBB.vector3dToVec3(max))
        let spot = aabb.getCenter().add(vehicle.getMotionX(), vehicle.getMotionY(), vehicle.getMotionZ())
        let deltaMovement = vehicle.getDeltaMovement()
        // let postionCombined = vehicle.position().add(spot.x(), spot.y(), spot.z());
        // let aabb = $VehicleMotionUtils.INSTANCE.calculateCombinedAABBOptimized(vehicle).inflate(0.5);
        // let aabb = AABB.of(obbBOX.min.x(), obbBOX.min.y(), obbBOX.min.z(), obbBOX.max.x(), obbBOX.max.y(), obbBOX.max.z()).move(obbBOX.center.x(), obbBOX.center.y(), obbBOX.center.z())
        // drawParticle("minecraft:end_rod", vehicle, postionCombined.x(), postionCombined.y(), postionCombined.z());
        drawParticle("minecraft:end_rod", vehicle, aabb.getCenter().x(), aabb.getCenter().y(), aabb.getCenter().z())
        drawAABB("minecraft:flame", vehicle, aabb)
        if (vehicle.tickCount % 60 !== 0) $TestTool.renderAABBEdgesWithParticles(vehicle.level, aabb, "minecraft:flame", 1, false)

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

        debugDriving(vehicle,
            `x=${x} y=${y} z=${z}`
        )
    }

})();
