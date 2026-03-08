const yargs = require('yargs')
const { hideBin } = require('yargs/helpers')

const app = require('./app')

function main () {
  yargs(hideBin(process.argv))
    .command('get_user <username>', 'check the status of a user', (yargs) => {
      return yargs.positional('username', { describe: 'the unique username of the user' })
    }, async (argv) => {
      const user = await app.getUser(argv.username)

      if (user) {
        console.log(user)
      } else {
        console.error(`No user found for username "${argv.username}"`)
      }
    })
    .command('add_user <username> [details]', 'create a new user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the unique username of the user' })
        .alias('n', 'name').describe('n', 'The display name of the user')
        .demandOption(['n'])
    }, async (argv) => {
      // TODO: auth tokens?

      const user = await app.createUser({ userId: argv.username, name: argv.name })
      console.log(user)
    })
    .command('list_sites <username>', 'show all the sites managed by the user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the username of the user' })
    }, async (argv) => {
      // TODO: auth tokens?

      const sites = await app.listSitesForUser(argv.username)
      console.log(sites)
    })

  // exports. = async (userId) => {

    .command('add_site', 'create a new site', (yargs) => {
      return yargs
        .example('add_site -o [username] -n [name]')
        .alias('o', 'owner').describe('o', 'The username of the site owner')
        .alias('n', 'name').describe('n', 'The name of the site')
        .demandOption(['o', 'n'])
    }, async (argv) => {
      const site = await app.createSite({ name: argv.name, userId: argv.owner })
      console.log(site)
    })
    .help('h')
    .alias('h', 'help')
    .demandCommand(1, 1, 'command required')
    .parse()
}

main()
