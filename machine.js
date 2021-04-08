const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const autoAuth = require('mineflayer-auto-auth')
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
  BehaviorPlaceBlock,
  BehaviorEquipItem,
  BehaviorInteractBlock,
  AbstractBehaviorInventory,
} = require('mineflayer-statemachine')
const v = require('vec3')
const mcDataLoader = require('minecraft-data')

const { Vec3 } = v

globalSettings.debugMode = false

function chester(bot, targets) {
  const mcData = mcDataLoader(bot.version)

  function hasNotChest() {
    const isChestEmpty = Object.keys(targets.chests).length === 0
    const isEmpty = (chest) => chest === null || !chest.isFull
    const emptyChest = Object.values(targets.chests).find(isEmpty)
    const hasNotEmptyChest = emptyChest === undefined
    return isChestEmpty || hasNotEmptyChest
  }

  function hasNotBotItem() {
    return bot.inventory.items().length === 0
  }

  const start = new AbstractBehaviorInventory(bot, targets)
  start.stateName = 'Start'
  start.onStateEntered = function onStateEntered() {
    this.targets.position = undefined
  }

  const end = new AbstractBehaviorInventory(bot, targets)
  end.stateName = 'End'
  end.onStateExited = function onStateExited() {
    const deleteIsFull = (key) => {
      delete this.targets.chests[key].isFull
    }
    Object.keys(this.targets.chests).forEach(deleteIsFull)
    if (this.targets.transitions) delete this.targets.transitions
  }

  const checkHasChest = new AbstractBehaviorInventory(bot, targets)
  checkHasChest.stateName = 'checkHasChest'
  checkHasChest.v = v
  checkHasChest.onStateEntered = function onStateEntered() {
    const point = this.bot.entity.position.floored()
    const positions = Object.keys(this.targets.chests).map((key) => this.v(key))
    const isNotFullChest = (position) => {
      const chest = this.targets.chests[position]
      return chest.isFull === undefined || chest.isFull === false
    }
    const positionsFiltered = positions.filter(
      (position) => this.bot.blockAt(position) && isNotFullChest(position)
    )
    const positionCompare = (a, b) => a.distanceTo(point) - b.distanceTo(point)
    const positionsFilteredSorted = positionsFiltered.sort(positionCompare)

    this.targets.position =
      positionsFilteredSorted.length > 0
        ? positionsFilteredSorted[0]
        : undefined
  }
  checkHasChest.isFinished = function isFinished() {
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
  depositAll.onStateEntered = function onStateEntered() {
    this.isFinished = false
    this.chest = undefined

    const block = this.bot.blockAt(this.targets.position)
    if (block == null || !this.bot.canSeeBlock(block)) return

    this.bot
      .openChest(block)
      .then((chest) => {
        this.chest = chest

        const getBotItems = () => this.bot.inventory.items()
        const getChestItems = () => chest.slots.slice(0, chest.inventoryStart)
        const equalItemType = (a) => (b) => a.type === b.type
        const matchesChestBotItem = (botItems) => (item) =>
          botItems.find(equalItemType(item))
        const botItemsSort = (botItems) =>
          botItems.sort((a, b) => a.stackSize - b.stackSize)
        const isEmptySlot = (item) => item === null
        const hasEmptySlot = (items) => items.find(isEmptySlot) !== undefined
        const hasItemDeposit = (items) => items.length > 0
        const canDeposit = (chestItems, botItems) =>
          hasEmptySlot(chestItems) && hasItemDeposit(botItems)
        const isNotFullStack = (item) =>
          item === null || item.count < item.stackSize
        const chestNotFullStack = (items) => items.filter(isNotFullStack)
        const depositItem = (chestWindow, type) =>
          chestWindow.deposit(type, null, this.bot.inventory.count(type))

        const hasNotEmptySlot = !hasEmptySlot(getChestItems())
        const canNotFillSlot =
          chestNotFullStack(getChestItems()).find(
            (item) => item === null || matchesChestBotItem(getBotItems())(item)
          ) === undefined

        if (hasNotEmptySlot && canNotFillSlot) {
          this.targets.chests[this.targets.position].isFull = true
          return Promise.resolve()
        }

        const matchItem = chestNotFullStack(getChestItems()).find(
          (item) => item !== null && matchesChestBotItem(getBotItems())(item)
        )

        if (matchItem) {
          return depositItem(chest, matchItem.type)
        }

        if (canDeposit(getChestItems(), getBotItems())) {
          const [firstItem] = botItemsSort(getBotItems())
          return depositItem(chest, firstItem.type)
        }

        return Promise.resolve()
      })
      .then(() => {
        this.isFinished = true
        this.bot.closeWindow(this.chest)
      })
      .catch((err) => {
        throw err
      })
  }
  depositAll.onStateExited = function onStateExited() {
    this.isFinished = false
  }

  const transitions = [
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: () => hasNotChest(),
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: () => hasNotBotItem(),
    }),
    new StateTransition({
      parent: start,
      child: checkHasChest,
      shouldTransition: () => true,
    }),
    new StateTransition({
      parent: checkHasChest,
      child: moveToChest,
      shouldTransition: () => checkHasChest.isFinished(),
    }),
    new StateTransition({
      parent: moveToChest,
      child: depositAll,
      shouldTransition: () => moveToChest.isFinished(),
    }),
    new StateTransition({
      parent: depositAll,
      child: start,
      shouldTransition: () => depositAll.isFinished,
    }),
    new StateTransition({
      parent: depositAll,
      child: start,
      shouldTransition: () => hasNotBotItem(),
    }),
  ]

  const stateMachine = new NestedStateMachine(transitions, start, end)
  stateMachine.stateName = 'Chester'
  return stateMachine
}

function farmer(bot, targets) {
  const mcData = mcDataLoader(bot.version)

  this.bot = bot
  this.targets = targets

  function isFullInventory() {
    return bot.inventory.emptySlotCount() < 3
  }

  const start = new BehaviorIdle()
  start.stateName = 'Start'

  const cleanUp = new BehaviorIdle()
  cleanUp.stateName = 'cleanUp'
  cleanUp.onStateEntered = () => {
    this.harvestState = true
    this.collectState = true
    this.sowState = true
    this.fertilizeState = true
    this.targets.oldBlocks = {}
  }

  const end = new BehaviorIdle()
  end.stateName = 'End'

  const findBlockToHarvest = new BehaviorFindBlock(bot, targets)
  findBlockToHarvest.stateName = 'findBlockToHarvest'
  findBlockToHarvest.mcData = mcData
  findBlockToHarvest.matchesBlock = function matchesBlock(block) {
    const { wheat, potatoes, carrots, beetroots } = this.mcData.blocksByName
    if (block.type === wheat.id && block.metadata === 7) return true
    if (block.type === potatoes.id && block.metadata === 7) return true
    if (block.type === carrots.id && block.metadata === 7) return true
    if (block.type === beetroots.id && block.metadata === 3) return true
    if (block.type === this.mcData.blocksByName.melon.id) return true
    if (block.type === this.mcData.blocksByName.pumpkin.id) return true
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
  collectItem.filter = (entity) =>
    EntityFilters().ItemDrops(entity) && entity.kind === 'Drops'

  const moveToCollectItem = new BehaviorMoveTo(bot, targets)
  moveToCollectItem.stateName = 'moveToCollectItem'
  moveToCollectItem.movements.canDig = false
  moveToCollectItem.movements.allowParkour = false
  moveToCollectItem.movements.blocksToAvoid.delete(mcData.blocksByName.wheat.id)
  moveToCollectItem.movements.blocksToAvoid.add(mcData.blocksByName.water.id)

  const findBlockToSow = new BehaviorFindBlock(bot, targets)
  findBlockToSow.stateName = 'findBlockToSow'
  findBlockToSow.blocks = [mcData.blocksByName.farmland.id]
  findBlockToSow.onStateEntered = function onStateEntered() {
    const blockToSow = this.bot.findBlock({
      matching: (block) => this.matchesBlock(block),
      maxDistance: this.maxDistance,
      useExtraInfo: (block) => {
        const blockAbove = this.bot.blockAt(block.position.offset(0, 1, 0))
        return !blockAbove || blockAbove.type === 0
      },
    })
    if (blockToSow) {
      this.targets.position = blockToSow.position
    }
  }

  const findSeedToSow = new AbstractBehaviorInventory(bot, targets)
  findSeedToSow.stateName = 'findSeedToSow'
  findSeedToSow.onStateEntered = function onStateEntered() {
    const botItems = this.bot.inventory.items()
    if (!botItems) return
    const {
      wheat_seeds: wheatSeeds,
      carrot,
      potato,
      beetroot_seeds: beetrootSeeds,
    } = this.mcData.itemsByName
    const items = [wheatSeeds, carrot, potato, beetrootSeeds].map(
      (item) => item.id
    )
    const botItemsFiltered = botItems.filter((item) =>
      items.includes(item.type)
    )
    if (!botItemsFiltered) return
    const itemCompare = (a, b) => a.type - b.type
    const botItemsFilteredSorted = botItemsFiltered.sort(itemCompare)
    const blockAbovePosition = this.targets.position.offset(0, 1, 0)
    const block = this.targets.oldBlocks[blockAbovePosition]
    if (!block) {
      ;[this.targets.item] = botItemsFilteredSorted
      return
    }
    this.targets.oldBlocks[targets.position] = undefined
    const { wheat, carrots, potatoes, beetroots } = this.mcData.blocksByName
    const blockAndItems = {
      [wheat.id]: wheatSeeds,
      [carrots.id]: carrot,
      [potatoes.id]: potato,
      [beetroots.id]: beetrootSeeds,
    }
    const findBlockItem = (item) =>
      blockAndItems[block.type] && blockAndItems[block.type].id === item.type
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
  sow.onStateEntered = function onStateEntered() {
    if (this.targets.item == null) return
    if (this.targets.position == null) return

    const block = this.bot.blockAt(this.targets.position)
    if (block == null || !this.bot.canSeeBlock(block)) return

    this.bot.placeBlock(block, new Vec3(0, 1, 0)).catch((err) => {
      throw err
    })
  }
  sow.isFinished = function isFinished() {
    const blockAbove = this.bot.blockAt(this.targets.position.offset(0, 1, 0))
    return blockAbove && blockAbove.type !== 0
  }

  const findBlockToFertilize = new BehaviorFindBlock(bot, targets)
  findBlockToFertilize.stateName = 'findBlockToFertilize'
  findBlockToFertilize.mcData = mcData
  findBlockToFertilize.matchesBlock = function matchesBlock(block) {
    const { wheat, potatoes, carrots, beetroots } = this.mcData.blocksByName
    if (block.type === wheat.id && block.metadata < 7) return true
    if (block.type === potatoes.id && block.metadata < 7) return true
    if (block.type === carrots.id && block.metadata < 7) return true
    if (block.type === beetroots.id && block.metadata < 3) return true
    return false
  }

  const checkHasFertilizeItem = new AbstractBehaviorInventory(bot, targets)
  checkHasFertilizeItem.stateName = 'checkHasFertilizeItem'
  checkHasFertilizeItem.onStateEntered = function onStateEntered() {
    this.targets.item = this.bot.inventory
      .items()
      .find((item) => item.type === this.mcData.itemsByName.bone_meal.id)
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
      shouldTransition: () => true,
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: () => isFullInventory(),
    }),
    new StateTransition({
      parent: start,
      child: findBlockToHarvest,
      shouldTransition: () => this.harvestState,
    }),
    new StateTransition({
      parent: start,
      child: collectItem,
      shouldTransition: () => this.collectState,
    }),
    new StateTransition({
      parent: start,
      child: findBlockToSow,
      shouldTransition: () => this.sowState,
    }),
    new StateTransition({
      parent: start,
      child: findBlockToFertilize,
      shouldTransition: () => this.fertilizeState,
    }),
    new StateTransition({
      parent: start,
      child: end,
      shouldTransition: () => true,
    }),
    new StateTransition({
      parent: findBlockToHarvest,
      child: start,
      shouldTransition: () => this.targets.position === undefined,
      onTransition: () => {
        this.harvestState = false
      },
    }),
    new StateTransition({
      parent: findBlockToHarvest,
      child: moveToHarvest,
      shouldTransition: () => this.targets.position !== undefined,
    }),
    new StateTransition({
      parent: moveToHarvest,
      child: harvest,
      shouldTransition: () => moveToHarvest.isFinished(),
      onTransition: () => {
        this.targets.oldBlocks[this.targets.position] = bot.blockAt(
          this.targets.position
        )
      },
    }),
    new StateTransition({
      parent: harvest,
      child: collectItem,
      shouldTransition: () => harvest.isFinished,
      onTransition: () => {
        this.targets.position = undefined
      },
    }),
    new StateTransition({
      parent: collectItem,
      child: start,
      shouldTransition: () => this.targets.entity === undefined,
      onTransition: () => {
        this.collectState = false
      },
    }),
    new StateTransition({
      parent: collectItem,
      child: moveToCollectItem,
      shouldTransition: () => this.targets.entity !== undefined,
      onTransition: () => {
        this.targets.position = this.targets.entity.position
          .offset(0, 0.2, 0)
          .floored()
      },
    }),
    new StateTransition({
      parent: moveToCollectItem,
      child: findBlockToSow,
      shouldTransition: () => moveToCollectItem.isFinished(),
      onTransition: () => {
        this.targets.entity = undefined
        this.targets.position = undefined
      },
    }),
    new StateTransition({
      parent: findBlockToSow,
      child: start,
      shouldTransition: () => this.targets.position === undefined,
      onTransition: () => {
        this.sowState = false
      },
    }),
    new StateTransition({
      parent: findBlockToSow,
      child: findSeedToSow,
      shouldTransition: () => this.targets.position !== undefined,
    }),
    new StateTransition({
      parent: findSeedToSow,
      child: start,
      shouldTransition: () => this.targets.item === undefined,
      onTransition: () => {
        this.sowState = false
        this.targets.position = undefined
      },
    }),
    new StateTransition({
      parent: findSeedToSow,
      child: equipSowItem,
      shouldTransition: () => this.targets.item !== undefined,
    }),
    new StateTransition({
      parent: equipSowItem,
      child: moveToSow,
      shouldTransition: () => !equipSowItem.wasEquipped,
    }),
    new StateTransition({
      parent: moveToSow,
      child: sow,
      shouldTransition: () => moveToSow.isFinished(),
    }),
    new StateTransition({
      parent: sow,
      child: cleanUp,
      shouldTransition: () => sow.isFinished,
      onTransition: () => {
        this.targets.item = undefined
        this.targets.position = undefined
      },
    }),
    new StateTransition({
      parent: findBlockToFertilize,
      child: start,
      shouldTransition: () => this.targets.position === undefined,
      onTransition: () => {
        this.fertilizeState = false
      },
    }),
    new StateTransition({
      parent: findBlockToFertilize,
      child: checkHasFertilizeItem,
      shouldTransition: () => this.targets.position !== undefined,
    }),
    new StateTransition({
      parent: checkHasFertilizeItem,
      child: cleanUp,
      shouldTransition: () => this.targets.item === undefined,
      onTransition: () => {
        this.fertilizeState = false
        this.targets.position = undefined
      },
    }),
    new StateTransition({
      parent: checkHasFertilizeItem,
      child: equipFertilizeItem,
      shouldTransition: () => this.targets.item !== undefined,
    }),
    new StateTransition({
      parent: equipFertilizeItem,
      child: moveToFertilize,
      shouldTransition: () => !equipFertilizeItem.wasEquipped,
    }),
    new StateTransition({
      parent: moveToFertilize,
      child: fertilize,
      shouldTransition: () => moveToFertilize.isFinished(),
    }),
    new StateTransition({
      parent: fertilize,
      child: findBlockToFertilize,
      shouldTransition: () => true,
      onTransition: () => {
        this.targets.item = undefined
        this.targets.position = undefined
      },
    }),
  ]

  const stateMachine = new NestedStateMachine(transitions, cleanUp, end)
  stateMachine.stateName = 'Farmer'
  return stateMachine
}

function botOnceSpawn() {
  const targets = {}
  targets.actives = {}
  // targets.actives.farming = true
  // targets.actives.chesting = true
  targets.chests = {}

  const start = new BehaviorIdle()
  start.stateName = 'Main Start'

  const farming = farmer(this, targets)
  const chesting = chester(this, targets)

  const transitions = [
    new StateTransition({
      parent: start,
      child: farming,
      shouldTransition: () => targets.actives.farming,
    }),
    new StateTransition({
      parent: farming,
      child: start,
      shouldTransition: () => farming.isFinished(),
    }),
    new StateTransition({
      parent: start,
      child: chesting,
      shouldTransition: () => targets.actives.chesting,
    }),
    new StateTransition({
      parent: chesting,
      child: start,
      shouldTransition: () => chesting.isFinished(),
    }),
  ]

  this.on('chat', (username, msg) => {
    if (msg === 'come') this.chat('/tp willywotz')
    if (msg === 'farm') transitions[0].trigger()
    if (msg === 'farm stop') transitions[1].trigger()
    if (msg === 'chest') transitions[2].trigger()
    if (msg === 'chest stop') transitions[3].trigger()
  })

  const rootLayer = new NestedStateMachine(transitions, start)
  rootLayer.stateName = 'Main'

  new BotStateMachine(this, rootLayer) // eslint-disable-line no-new
}

function createBot(options) {
  const bot = mineflayer.createBot(options)
  bot.loadPlugin(pathfinder)
  if (options.AutoAuth) bot.loadPlugin(autoAuth)
  bot.on('error', (e) => {
    throw e
  })
  bot.once('spawn', botOnceSpawn)
  return bot
}

module.exports = createBot
