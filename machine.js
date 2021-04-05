const {
  globalSettings,
  StateTransition,
  NestedStateMachine,
  BotStateMachine,
  BehaviorIdle,
  BehaviorFindBlock,
  BehaviorMoveTo,
  BehaviorMineBlock,
  BehaviorGetClosestEntity,
  EntityFilters,
  BehaviorPlaceBlock
} = require('mineflayer-statemachine')
const { Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { createBot } = require('./lib')

globalSettings.debugMode = true

const bot = createBot({
  username: 'hello'
})

bot.once('spawn', function () {
  const targets = {}

  const start = new BehaviorIdle
  start.stateName = 'start'

  const farming = farmer(this, targets)

  const transitions = [
    new StateTransition({
      parent: start,
      child: farming,
      shouldTransition: _ => true
    }),
  ]

  const rootLayer = new NestedStateMachine(transitions, start)
  new BotStateMachine(bot, rootLayer)
})

function farmer(bot, targets) {
  this.harvestState = true
  this.collectState = true
  this.sowState = true

  const mcData = require('minecraft-data')(bot.version)

  const start = new BehaviorIdle
  start.stateName = 'Start'

  const end = new BehaviorIdle
  end.stateName = 'end'

  const findBlockToHarvest = new BehaviorFindBlock(bot, targets)
  findBlockToHarvest.stateName = 'findBlockToHarvest'
  findBlockToHarvest.matchesBlock = block => {
    const { wheat, potatoes, carrots, beetroots } = mcData.blocksByName
    if (block.type === wheat.id && block.metadata === 7) return true;
    if (block.type === potatoes.id && block.metadata === 7) return true;
    if (block.type === carrots.id && block.metadata === 7) return true;
    if (block.type === beetroots.id && block.metadata === 3) return true;
    if (block.type === mcData.blocksByName.melon.id) return true;
    if (block.type === mcData.blocksByName.pumpkin.id) return true;
    return false
  }

  const moveToHarvest = new BehaviorMoveTo(bot, targets)
  moveToHarvest.stateName = 'moveToHarvest'
  moveToHarvest.movements.canDig = false
  moveToHarvest.movements.allowParkour = false
  moveToHarvest.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToHarvest.movements.blocksToAvoid.add(mcData.blocksByName.water.id)

  const harvest = new BehaviorMineBlock(bot, targets)
  harvest.stateName = 'harvest'

  const collectItem = new BehaviorGetClosestEntity(bot, targets)
  collectItem.stateName = 'collectItem'
  collectItem.filter = entity => {
    return EntityFilters().ItemDrops(entity) && entity.kind === 'Drops'
  }

  const moveToCollectItem = new BehaviorMoveTo(bot, targets)
  moveToCollectItem.stateName = 'moveToCollectItem'
  moveToCollectItem.movements.canDig = false
  moveToCollectItem.movements.allowParkour = false
  moveToCollectItem.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToCollectItem.movements.blocksToAvoid.add(mcData.blocksByName.water.id)

  const findSeedTowSow = new BehaviorIdle
  findSeedTowSow.stateName = 'findSeedTowSow'

  const findBlockToSow = new BehaviorFindBlock(bot, targets)
  findBlockToSow.stateName = 'findBlockToSow'
  findBlockToSow.blocks = [mcData.blocksByName.farmland.id]
  findBlockToSow.onStateEntered = function () {
    const block = this.bot.findBlock({
      matching: block => this.matchesBlock(block),
      maxDistance: this.maxDistance,
      useExtraInfo: block => {
        const blockAbove = this.bot.blockAt(block.position.offset(0, 1, 0))
        return !blockAbove || blockAbove.type === 0
      }
    })
    if (block) {
      this.targets.position = block.position
    }
  }

  const moveToSow = new BehaviorMoveTo(bot, targets)
  moveToSow.stateName = 'moveToSow'
  moveToSow.movements.canDig = false
  moveToSow.movements.allowParkour = false
  moveToSow.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToSow.movements.blocksToAvoid.add(mcData.blocksByName.water.id)

  const sow = new BehaviorPlaceBlock(bot, targets)
  sow.stateName = 'sow'

  const transitions = [
    new StateTransition({
      parent: start,
      child: findBlockToHarvest,
      shouldTransition: _ => this.harvestState
    }),
    new StateTransition({
      parent: start,
      child: collectItem,
      shouldTransition: _ => this.collectState
    }),
    new StateTransition({
      parent: start,
      child: findSeedTowSow,
      shouldTransition: _ => this.sowState,
      onTransition: _ => {
        targets.item = bot.inventory.items().find(item => {
          if (item.type === mcData.itemsByName.wheat_seeds.id) return true;
          if (item.type === mcData.itemsByName.potato.id) return true;
          if (item.type === mcData.itemsByName.carrot.id) return true;
          if (item.type === mcData.itemsByName.beetroot_seeds.id) return true;
          return false
        })
      }
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: _ => true
    }),
    new StateTransition({
      parent: end,
      child: start,
      shouldTransition: _ => true,
      onTransition: _ => {
        this.harvestState = true
        this.collectState = true
        this.sowState = true
      }
    }),
    new StateTransition({
      parent: findBlockToHarvest,
      child: start,
      shouldTransition: _ => targets.position === undefined,
      onTransition: _ => { this.harvestState = false }
    }),
    new StateTransition({
      parent: findBlockToHarvest,
      child: moveToHarvest,
      shouldTransition: _ => targets.position !== undefined
    }),
    new StateTransition({
      parent: moveToHarvest,
      child: harvest,
      shouldTransition: _ => moveToHarvest.distanceToTarget() < 3
    }),
    new StateTransition({
      parent: harvest,
      child: end,
      shouldTransition: _ => harvest.isFinished,
      onTransition: _ => { targets.position = undefined }
    }),
    new StateTransition({
      parent: collectItem,
      child: start,
      shouldTransition: _ => targets.entity === undefined,
      onTransition: _ => { this.collectState = false }
    }),
    new StateTransition({
      parent: collectItem,
      child: moveToCollectItem,
      shouldTransition: _ => targets.entity !== undefined,
      onTransition: _ => {
        targets.position = targets.entity.position.offset(0, 0.2, 0).floored()
      }
    }),
    new StateTransition({
      parent: moveToCollectItem,
      child: end,
      shouldTransition: _ => moveToCollectItem.isFinished(),
      onTransition: _ => {
        targets.entity = undefined
        targets.position = undefined
      }
    }),
    new StateTransition({
      parent: findSeedTowSow,
      child: start,
      shouldTransition: _ => targets.item === undefined,
      onTransition: _ => { this.sowState = false }
    }),
    new StateTransition({
      parent: findSeedTowSow,
      child: findBlockToSow,
      shouldTransition: _ => targets.item !== undefined
    }),
    new StateTransition({
      parent: findBlockToSow,
      child: start,
      shouldTransition: _ => targets.position === undefined,
      onTransition: _ => { this.sowState = false }
    }),
    new StateTransition({
      parent: findBlockToSow,
      child: moveToSow,
      shouldTransition: _ => targets.position !== undefined
    }),
    new StateTransition({
      parent: moveToSow,
      child: sow,
      shouldTransition: _ => moveToSow.isFinished(),
      onTransition: _ => { targets.blockFace = new Vec3(0, 1, 0) }
    }),
    new StateTransition({
      parent: sow,
      child: end,
      shouldTransition: _ => {
        const blockAbove = bot.blockAt(targets.position.offset(0, 1, 0))
        return blockAbove || blockAbove.type !== 0
      },
      onTransition: _ => {
        targets.blockFace = undefined
        targets.item = undefined
        targets.position = undefined
      }
    }),
  ]

  const farmer = new NestedStateMachine(transitions, start)
  farmer.stateName = 'Farmer'
  return farmer
}
