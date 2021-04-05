const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const autoAuth = require('mineflayer-auto-auth')

function createBot(options) {
  const bot = mineflayer.createBot(options)
  bot.loadPlugin(pathfinder)
  if (options.AutoAuth) bot.loadPlugin(autoAuth);
  bot.on('error', e => { throw e })
  bot.on('login', _ => console.log(`${bot.username} is connected.`))
  bot.on('end', _ => console.log(`${bot.username} is disconnected.`))
  return bot
}

module.exports = createBot
