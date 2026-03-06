const yargs = require('yargs')
const { hideBin } = require('yargs/helpers')

const db = require('./db')

function main () {
  yargs(hideBin(process.argv))
    .command('get_user <username>', 'check the status of a user', (yargs) => {
      return yargs.positional('username', { describe: 'the unique username of the user' })
    }, async (argv) => {
      const user = await db.getUser(argv.username)

      if (user) {
        console.log(user)
      } else {
        console.error(`No user found for username "${argv.username}"`)
      }
    })
    .command('add_user <username> [details]', 'create a new user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the unique username of the user' })
        .alias('n', 'name')
        .describe('n', 'The display name of the user')
    }, async (argv) => {
      // TODO: auth tokens?

      const user = await db.createUser({ userId: argv.username, name: argv.name })
      console.log(user)
    })
    .help('h')
    .alias('h', 'help')
    .demandCommand(1, 1, 'command required')
    .parse()
}

main()
