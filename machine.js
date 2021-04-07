const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const autoAuth = require('mineflayer-auto-auth')
const {
  globalSettings,
  StateTransition,
  NestedStateMachine,
  BotStateMachine,
  StateMachineWebserver,
  BehaviorIdle,
  BehaviorFindBlock,
  BehaviorMoveTo,
  BehaviorMineBlock,
  BehaviorGetClosestEntity,
  EntityFilters,
  BehaviorPlaceBlock,
  BehaviorEquipItem,
  BehaviorInteractBlock,
  AbstractBehaviorInventory
} = require('mineflayer-statemachine')
const v = require('vec3')
const { Vec3 } = v
const mcDataLoader = require('minecraft-data')

globalSettings.debugMode = true

function createBot(options) {
  const bot = mineflayer.createBot(options)
  bot.loadPlugin(pathfinder)
  if (options.AutoAuth) bot.loadPlugin(autoAuth);
  bot.on('error', e => { throw e })
  bot.on('login', _ => console.log(`${bot.username} is connected.`))
  bot.on('end', _ => console.log(`${bot.username} is disconnected.`))
  return bot
}

const bot = createBot({
  username: 'hello'
})

bot.once('spawn', function () {
  const targets = {}
  targets.actives = {}
  // targets.actives.farming = true
  // targets.actives.chesting = true
  targets.chests = {
    [new Vec3(-66, 4, -15)]: Object.create(null)
  }

  const start = new BehaviorIdle
  start.stateName = 'Main Start'

  const chat = new BehaviorIdle
  chat.stateName = 'chat'

  const farming = farmer(this, targets)
  const chesting = chester(this, targets)

  const transitions = [
    new StateTransition({
      parent: start,
      child: farming,
      shouldTransition: _ => targets.actives.farming
    }),
    new StateTransition({
      parent: farming,
      child: start,
      shouldTransition: _ => farming.isFinished()
    }),
    new StateTransition({
      parent: start,
      child: chesting,
      shouldTransition: _ => targets.actives.chesting
    }),
    new StateTransition({
      parent: chesting,
      child: start,
      shouldTransition: _ => chesting.isFinished()
    }),
  ]

  bot.on('chat', (username, msg) => {
    if (msg === 'come') bot.chat('/tp willywotz');
    if (msg === 'farm') transitions[0].trigger();
    if (msg === 'farm stop') transitions[1].trigger();
    if (msg === 'chest') transitions[2].trigger();
    if (msg === 'chest stop') transitions[3].trigger();
  })

  const rootLayer = new NestedStateMachine(transitions, start)
  rootLayer.stateName = 'Main'
  const stateMachine = new BotStateMachine(bot, rootLayer)
  const webserver = new StateMachineWebserver(bot, stateMachine)
  webserver.startServer()
})

function chester(bot, targets) {
  const mcData = mcDataLoader(bot.version)

  function hasNotChest() {
    const hasNotChest = Object.keys(targets.chests).length === 0
    const isEmpty = chest => chest === null || !chest.isFull
    const emptyChest = Object.values(targets.chests).find(isEmpty)
    const hasNotEmptyChest = emptyChest === undefined
    return hasNotChest || hasNotEmptyChest
  }

  function hasNotBotItem() {
    return bot.inventory.items().length === 0
  }

  const start = new AbstractBehaviorInventory(bot, targets)
  start.stateName = 'Start'
  start.onStateEntered = function () {
    this.targets.position = undefined
  }

  const end = new AbstractBehaviorInventory(bot, targets)
  end.stateName = 'End'
  end.onStateExited = function () {
    const deleteIsFull = chest => { delete chest.isFull }
    Object.keys(this.targets.chests).forEach(deleteIsFull)
    if (targets.transitions) delete targets.transitions;
  }

  const checkHasChest = new AbstractBehaviorInventory(bot, targets)
  checkHasChest.stateName = 'checkHasChest'
  checkHasChest.v = v
  checkHasChest.onStateEntered = function () {
    const point = this.bot.entity.position.floored()
    const positions = Object.keys(this.targets.chests).map(key => this.v(key))
    const isNotFullChest = position => {
      const chest = this.targets.chests[position]
      return chest.isFull === undefined || chest.isFull === false
    }
    const positionsFiltered = positions.filter(position => {
      return this.bot.blockAt(position) && isNotFullChest(position)
    })
    const positionCompare = (a, b) => a.distanceTo(point) - b.distanceTo(point)
    const positionsFilteredSorted = positionsFiltered.sort(positionCompare)

    this.targets.position = positionsFilteredSorted.length > 0
      ? positionsFilteredSorted[0]
      : undefined
  }
  checkHasChest.isFinished = function () {
    return this.targets.position !== undefined
  }

  const moveToChest = new BehaviorMoveTo(bot, targets)
  moveToChest.stateName = 'moveToChest'
  moveToChest.movements.canDig = false
  moveToChest.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToChest.movements.blocksToAvoid.add(mcData.blocksByName.water.id)
  moveToChest.distance = 1

  const depositAll = new AbstractBehaviorInventory(bot, targets)
  depositAll.stateName = 'depositAll'
  depositAll.onStateEntered = function () {
    this.isFinished = false
    this.chest = undefined

    const block = this.bot.blockAt(this.targets.position)
    if (block == null || !this.bot.canSeeBlock(block)) return;

    this.bot.openChest(block).then(chest => {
      this.chest = chest

      const botItems = _ => this.bot.inventory.items()
      const chestItems = _ => chest.slots.slice(0, chest.inventoryStart)
      const equalItemType = chest => bot => chest.type === bot.type
      const matchesChestBotItem = botItems => item => botItems.find(equalItemType(item))
      const botItemsSort = botItems => botItems.sort((a, b) => a.stackSize - b.stackSize)
      const isEmptySlot = item => item === null
      const hasEmptySlot = chestItems => chestItems.find(isEmptySlot) !== undefined
      const hasItemDeposit = items => items.length > 0
      const canDeposit = (chestItems, items) => hasEmptySlot(chestItems) && hasItemDeposit(items)
      const isNotFullStack = item => item === null || item.count < item.stackSize
      const chestNotFullStack = chestItems => chestItems.filter(isNotFullStack)
      const depositItem = (chest, type) => chest.deposit(type, null, this.bot.inventory.count(type))

      const hasNotEmptySlot = !hasEmptySlot(chestItems())
      const canNotFillSlot = chestNotFullStack(chestItems()).find(item => {
        return item === null || matchesChestBotItem(botItems())(item)
      }) === undefined

      if (hasNotEmptySlot && canNotFillSlot) {
        this.targets.chests[this.targets.position].isFull = true
        return
      }

      const matchItem = chestNotFullStack(chestItems()).find(item => {
        return item !== null && matchesChestBotItem(botItems())(item)
      })
      if (matchItem) {
        return depositItem(chest, matchItem.type)
      }

      if (canDeposit(chestItems(), botItems())) {
        return depositItem(chest, botItemsSort(botItems())[0].type)
      }
    }).then(_ => {
      this.isFinished = true
      this.bot.closeWindow(this.chest)
    }).catch(console.log)
  }
  depositAll.onStateExited = function () {
    this.isFinished = false
  }

  const transitions = [
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: _ => hasNotChest()
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: _ => hasNotBotItem()
    }),
    new StateTransition({
      parent: start,
      child: checkHasChest,
      shouldTransition: _ => true
    }),
    new StateTransition({
      parent: checkHasChest,
      child: moveToChest,
      shouldTransition: _ => checkHasChest.isFinished()
    }),
    new StateTransition({
      parent: moveToChest,
      child: depositAll,
      shouldTransition: _ => moveToChest.isFinished()
    }),
    new StateTransition({
      parent: depositAll,
      child: start,
      shouldTransition: _ => depositAll.isFinished
    }),
    new StateTransition({
      parent: depositAll,
      child: start,
      shouldTransition: _ => hasNotBotItem()
    }),
  ]

  const chester = new NestedStateMachine(transitions, start, end)
  chester.stateName = 'Chester'
  return chester
}

function farmer(bot, targets) {
  const mcData = mcDataLoader(bot.version)

  function isFullInventory() {
    return bot.inventory.emptySlotCount() < 3
  }

  const start = new BehaviorIdle
  start.stateName = 'Start'

  const cleanUp = new BehaviorIdle
  cleanUp.stateName = 'cleanUp'
  cleanUp.onStateEntered = _ => {
    this.harvestState = true
    this.collectState = true
    this.sowState = true
    this.fertilizeState = true
    targets.oldBlocks = {}
  }

  const end = new BehaviorIdle
  end.stateName = 'End'

  const findBlockToHarvest = new BehaviorFindBlock(bot, targets)
  findBlockToHarvest.stateName = 'findBlockToHarvest'
  findBlockToHarvest.mcData = mcData
  findBlockToHarvest.matchesBlock = function (block) {
    const { wheat, potatoes, carrots, beetroots } = this.mcData.blocksByName
    if (block.type === wheat.id && block.metadata === 7) return true;
    if (block.type === potatoes.id && block.metadata === 7) return true;
    if (block.type === carrots.id && block.metadata === 7) return true;
    if (block.type === beetroots.id && block.metadata === 3) return true;
    if (block.type === this.mcData.blocksByName.melon.id) return true;
    if (block.type === this.mcData.blocksByName.pumpkin.id) return true;
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

  const findSeedToSow = new AbstractBehaviorInventory(bot, targets)
  findSeedToSow.stateName = 'findSeedToSow'
  findSeedToSow.onStateEntered = function () {
    const botItems = this.bot.inventory.items()
    if (!botItems) return;
    const { wheat_seeds, carrot, potato, beetroot_seeds } = this.mcData.itemsByName
    const items = [wheat_seeds, carrot, potato, beetroot_seeds].map(item => item.id)
    const botItemsFiltered = botItems.filter(item => items.includes(item.type))
    if (!botItemsFiltered) return;
    const itemCompare = (a, b) => a.type < b.type ? -1 : (a.type > b.type ? 1 : 0)
    const botItemsFilteredSorted = botItemsFiltered.sort(itemCompare)
    const block = this.targets.oldBlocks[targets.position.offset(0, 1, 0)]
    if (!block) return this.targets.item = botItemsFilteredSorted[0];
    this.targets.oldBlocks[targets.position] = undefined;
    const { wheat, carrots, potatoes, beetroots } = this.mcData.blocksByName
    const blockAndItems = { [wheat.id]: wheat_seeds, [carrots.id]: carrot, [potatoes.id]: potato, [beetroots.id]: beetroot_seeds }
    const findBlockItem = item => blockAndItems[block.type] && blockAndItems[block.type].id === item.type
    this.targets.item = botItemsFilteredSorted.find(findBlockItem)
  }

  const equipSowItem = new BehaviorEquipItem(bot, targets)
  equipSowItem.stateName = 'equipSowItem'

  const moveToSow = new BehaviorMoveTo(bot, targets)
  moveToSow.stateName = 'moveToSow'
  moveToSow.movements.canDig = false
  moveToSow.movements.allowParkour = false
  moveToSow.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToSow.movements.blocksToAvoid.add(mcData.blocksByName.water.id)

  const sow = new BehaviorPlaceBlock(bot, targets)
  sow.stateName = 'sow'
  sow.onStateEntered = function () {
    if (this.targets.item == null) return
    if (this.targets.position == null) return

    const block = this.bot.blockAt(this.targets.position)
    if (block == null || !this.bot.canSeeBlock(block)) return

    this.bot.placeBlock(block, new Vec3(0, 1, 0)).catch(err => {
      if (globalSettings.debugMode) console.log(err);
    })
  }
  sow.isFinished = function () {
    const blockAbove = this.bot.blockAt(this.targets.position.offset(0, 1, 0))
    return blockAbove && blockAbove.type !== 0
  }

  const findBlockToFertilize = new BehaviorFindBlock(bot, targets)
  findBlockToFertilize.stateName = 'findBlockToFertilize'
  findBlockToFertilize.mcData = mcData
  findBlockToFertilize.matchesBlock = function (block) {
    const { wheat, potatoes, carrots, beetroots } = this.mcData.blocksByName
    if (block.type === wheat.id && block.metadata < 7) return true;
    if (block.type === potatoes.id && block.metadata < 7) return true;
    if (block.type === carrots.id && block.metadata < 7) return true;
    if (block.type === beetroots.id && block.metadata < 3) return true;
    return false
  }

  const checkHasFertilizeItem = new AbstractBehaviorInventory(bot, targets)
  checkHasFertilizeItem.stateName = 'checkHasFertilizeItem'
  checkHasFertilizeItem.onStateEntered = function () {
    this.targets.item = this.bot.inventory.items().find(item => {
      return item.type === this.mcData.itemsByName.bone_meal.id
    })
  }

  const equipFertilizeItem = new BehaviorEquipItem(bot, targets)
  equipFertilizeItem.stateName = 'equipFertilizeItem'

  const moveToFertilize = new BehaviorMoveTo(bot, targets)
  moveToFertilize.stateName = 'moveToFertilize'
  moveToFertilize.movements.canDig = false
  moveToFertilize.movements.allowParkour = false
  moveToFertilize.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToFertilize.movements.blocksToAvoid.add(mcData.blocksByName.water.id)

  const fertilize = new BehaviorInteractBlock(bot, targets)
  fertilize.stateName = 'fertilize'

  const transitions = [
    new StateTransition({
      parent: cleanUp,
      child: start,
      shouldTransition: _ => true
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: _ => isFullInventory()
    }),
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
      child: findBlockToSow,
      shouldTransition: _ => this.sowState
    }),
    new StateTransition({
      parent: start,
      child: findBlockToFertilize,
      shouldTransition: _ => this.fertilizeState
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: _ => true
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
      shouldTransition: _ => moveToHarvest.isFinished(),
      onTransition: _ => {
        targets.oldBlocks[targets.position] = bot.blockAt(targets.position)
      }
    }),
    new StateTransition({
      parent: harvest,
      child: collectItem,
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
      child: findBlockToSow,
      shouldTransition: _ => moveToCollectItem.isFinished(),
      onTransition: _ => {
        targets.entity = undefined
        targets.position = undefined
      }
    }),
    new StateTransition({
      parent: findBlockToSow,
      child: start,
      shouldTransition: _ => targets.position === undefined,
      onTransition: _ => { this.sowState = false }
    }),
    new StateTransition({
      parent: findBlockToSow,
      child: findSeedToSow,
      shouldTransition: _ => targets.position !== undefined
    }),
    new StateTransition({
      parent: findSeedToSow,
      child: start,
      shouldTransition: _ => targets.item === undefined,
      onTransition: _ => {
        this.sowState = false
        targets.position = undefined
      }
    }),
    new StateTransition({
      parent: findSeedToSow,
      child: equipSowItem,
      shouldTransition: _ => targets.item !== undefined
    }),
    new StateTransition({
      parent: equipSowItem,
      child: moveToSow,
      shouldTransition: _ => !equipSowItem.wasEquipped
    }),
    new StateTransition({
      parent: moveToSow,
      child: sow,
      shouldTransition: _ => moveToSow.isFinished(),
    }),
    new StateTransition({
      parent: sow,
      child: cleanUp,
      shouldTransition: _ => sow.isFinished,
      onTransition: _ => {
        targets.item = undefined
        targets.position = undefined
      }
    }),
    new StateTransition({
      parent: findBlockToFertilize,
      child: start,
      shouldTransition: _ => targets.position === undefined,
      onTransition: _ => { this.fertilizeState = false }
    }),
    new StateTransition({
      parent: findBlockToFertilize,
      child: checkHasFertilizeItem,
      shouldTransition: _ => targets.position !== undefined
    }),
    new StateTransition({
      parent: checkHasFertilizeItem,
      child: cleanUp,
      shouldTransition: _ => targets.item === undefined,
      onTransition: _ => {
        this.fertilizeState = false
        targets.position = undefined
      }
    }),
    new StateTransition({
      parent: checkHasFertilizeItem,
      child: equipFertilizeItem,
      shouldTransition: _ => targets.item !== undefined
    }),
    new StateTransition({
      parent: equipFertilizeItem,
      child: moveToFertilize,
      shouldTransition: _ => !equipFertilizeItem.wasEquipped
    }),
    new StateTransition({
      parent: moveToFertilize,
      child: fertilize,
      shouldTransition: _ => moveToFertilize.isFinished()
    }),
    new StateTransition({
      parent: fertilize,
      child: findBlockToFertilize,
      shouldTransition: _ => true,
      onTransition: _ => {
        targets.item = undefined
        targets.position = undefined
      }
    }),
  ]

  const farmer = new NestedStateMachine(transitions, cleanUp, end)
  farmer.stateName = 'Farmer'
  return farmer
}
