// Visit the wiki for more info - https://kubejs.com/
// requires: superbwarfare

const { $Quaternion } = require("@package/gg/essential/model/util");

(() => {

    const { $Double } = require("@package/java/lang");
    const { $Vector3d, $Vector2d } = require("@package/org/joml");
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

        if (vehicle.enableAABB()) return;

        let obbList = vehicle.getOBBs()


        let min = new $Vector3d($Double.MAX_VALUE, $Double.MAX_VALUE, $Double.MAX_VALUE)
        let max = new $Vector3d(-$Double.MAX_VALUE, -$Double.MAX_VALUE, -$Double.MAX_VALUE)
        let vehicleRotation = vehicle.getRotationVector();

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

        let width = (max.x() - min.x()) + Math.sin(vehicleRotation.x);
        let height = (max.y() - min.y()) + Math.cos(vehicleRotation.y);
        let depth = (max.z() - min.z()) + Math.sin(vehicleRotation.x);


        let postion = vehicle.position()
        let aabb = new $AABB($OBB.vector3dToVec3(min), $OBB.vector3dToVec3(max))

        let deltaMovement = vehicle.getDeltaMovement().scale(1)
        let spot = aabb.getCenter().add(deltaMovement.x(), deltaMovement.y(), deltaMovement.z())


        debugDriving(vehicle, `Vehicle AABB Size ${aabb.getSize()} Rotation: ${vehicleRotation.length()} Width: ${width} Height: ${height} Depth: ${depth}`)
        drawParticle("minecraft:end_rod", vehicle, aabb.getCenter().x(), aabb.getCenter().y(), aabb.getCenter().z())
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
    }

})();
