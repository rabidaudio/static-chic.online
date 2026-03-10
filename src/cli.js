const yargs = require('yargs')
const { hideBin } = require('yargs/helpers')
const prompts = require('@inquirer/prompts')
const chalk = require('chalk')

const isInteractive = require('is-interactive').default()

// cmd is a middleware pattern for orchestrating cli commands
const noOpMiddleware = async (argv, next) => next(argv)
const cmd = (initialMiddleware = noOpMiddleware) => {
  const _cmd = async (argv) => {
    const cont = (rem) => async (...args) => {
      if (rem.length === 0) return
      const [m, ...rest] = rem
      return await m((args.length >= 1 ? args[0] : argv), cont(rest))
    }
    return await cont(_cmd._middleware)(argv)
  }
  _cmd._middleware = [initialMiddleware]
  _cmd.use = (middleware) => {
    _cmd._middleware.push(middleware)
    return _cmd
  }
  _cmd.do = _cmd.use // alias
  return _cmd
}

const demandOption = (option, checkFn = (v) => !!v) => async (argv, next) => {
  if (!checkFn(argv[option])) {
    console.error(`Missing required argument: ${option}`)
    process.exit(1)
  } else {
    return await next(argv)
  }
}

const requestOption = (option, requestFn) => async (argv, next) => {
  if (argv[option]) return await next()
  argv[option] = await requestFn(argv)
  return await next()
}

const authenticateUser = async (argv, next) => {
  console.log('authenticateUser')
  // check auth token in localStorage
  //  exists? return it
  // interactive? go through login flow
  // throw error token or deploy key is required
  // TODO: support non-interactive registration?
  return await next(argv)
}

const authenticateUserOrToken = async (argv, next) => {
  console.log('authenticateUserOrToken')
  return await next(argv)
}

const requestSite = requestOption('site', async () => {
  if (isInteractive) {
    // TODO: get the user's sites
    return await prompts.select({
      message: 'Select a site',
      choices: [
        { name: 'Test Site [teeny-angle-dwas5]', value: 'teeny-angle-dwas5', description: 'created today' },
        { name: 'Test Site 2 [example.com]', value: 'foo-bar-baz', description: 'updated 1 year ago' }
      ]
    })
  }
})

module.exports = async function main (inArgv = process.argv) {
  const cli = yargs(hideBin(inArgv))
    .scriptName('statchic') // TODO

    .usage(`${chalk.bold('$0')}   ` +
        chalk.green('Create and deploy static sites on', chalk.underline('static-chic.online') + '.\n\n') +

        '  $0 init\n' +
        '  $0 deploy --promote myapp/dist\n\n' +

        chalk.bold('Authentication') + '\n' + chalk.dim(chalk.underline('static-chic.online'),
        'uses GitHub for authentication. When running interactively it will prompt for you ' +
        'to log in if needed and store your authentication token on your device.\n\n') +

        chalk.bold('Deploy Key') + '\n' + chalk.dim(
        'When running non-interactively, such as during a CI ' +
        'build process, most commands can instead use a deploy key. A deploy key is generated ' +
        'when a site is initialized. Set this value to an `SC_DEPLOY_KEY` environment variable ' +
        'in your build environment to authenticate deployments and promotions.\n\n') +

        chalk.bold('Custom Domains') + '\n' + chalk.dim(
        'Every site is given a site ID which is used as a unique subdomain, e.g. `' +
        chalk.underline('teeny-angle-dwas5.site.static-chic.online') + '`. ' +
        'In addition, you can specify a custom domain, like `' + chalk.underline('www.example.com') + '`. ' +
        'SSL certificate will be automatically provisioned. You will need to create a CNAME record ' +
        'pointing this domain to the default domain for the site before you can attach it to the site. ' +
        'Contact your DNS provider for directions.\n\n')
    )
  cli.siteOption = function () {
    return this.option('site', {
      alias: 's',
      type: 'string',
      describe: 'The site subdomain, e.g. `teeny-angle-dwas5`'
    })
      .default('site', () => {
        if (process.env.SC_SITE_ID) return process.env.SC_SITE_ID
      }, '$SC_SITE_ID')
  }

  cli.command('init', chalk.bold('Create a new site.'), y =>
    y.option('name', {
      alias: 'n',
      describe: 'A name for the site'
    }), cmd()
    .use(authenticateUser)
    .use(requestOption('name', async () => {
      if (isInteractive) {
        return await prompts.input({ message: 'Enter a name for the site:', required: false })
      }
    }))
    .do(init)
  )

    .command('configure', chalk.bold('Change the settings of a site.'), y =>
      y.example('configure --site teeny-angle-dwas5 --domain example.com')
        .siteOption()
        .option('domain', {
          alias: 'd',
          string: true,
          boolean: true,
          describe: 'Add a custom domain to the site. Remove it by setting to blank or using `--no-domain`'
        })
        .coerce('domain', (arg) => (typeof arg === 'boolean' ? null : (arg === '' ? null : arg))),
    cmd()
      .use(authenticateUserOrToken)
      .use(requestSite)
      .use(demandOption('site'))
      .do(configure))

    .command('deploy [path]', chalk.bold('Create a new deployment for the site.\n') +
        chalk.dim('A deployment isn\'t automatically promoted to live by default. Use the ' +
        '`promote` command or the `--promote` flag to promote after deployment.'), y =>
      y.example('deploy --site teeny-angle-dwas5 --promote --wait myapp/dist')
        .positional('path', { describe: 'The path to the root directory of static files', normalize: true })
        .siteOption()
        .option('exclude', { alias: 'x', describe: 'a glob of files relative to `path` to exclude from the deployment', type: 'array', default: [] })
        .option('promote', { alias: 'p', describe: 'promote after deployment', type: 'boolean' })
        .option('wait', { alias: 'w', describe: 'wait for the invalidation to complete (if also promoting)', type: 'boolean' })
        .demandOption('path')
        .implies('wait', 'promote'),
    cmd()
      .use(authenticateUserOrToken)
      .use(requestSite)
      .use(demandOption('site'))
      .do(deploy))

    .command('promote [deployment]', chalk.bold('Make a deployment live.'), y =>
      y.example('promote --wait --site teeny-angle-dwas5 0000019cd5515615dd304c19')
        .siteOption()
        .positional('deployment', {
          describe: 'The ID of the deployment to promote, e.g. `0000019cd5515615dd304c19`.'
        }).default('deployment', () => {
          if (process.env.SC_DEPLOY_ID) return process.env.SC_DEPLOY_ID
        }, '$SC_DEPLOY_ID')
        .option('wait', { alias: 'w', describe: 'wait for the invalidation to complete', type: 'boolean' }),
    cmd()
      .use(authenticateUserOrToken)
      .use(requestSite)
      .use(demandOption('site'))
      .use(requestOption('deployment', async () => {
        if (isInteractive) {
          // TODO: get the site's deployments
          return await prompts.select({
            message: 'Select a deployment',
            choices: [
              { name: chalk.bold('*added new posts [d55156]'), value: 'd55156', description: 'created today' },
              { name: 'initial [304c19]', value: '304c19', description: 'updated 1 year ago' }
            ]
          })
        }
      }))
      .use(demandOption('deployment'))
      .do(promote))

  // authenticate user or deploykey
  // if interactive, show a list of deployments else if specified else -n count else -n -1
  // .command('rollback')

  // .command('destroy')

    .help('help')
    .command('help', false, (y) => y, (argv) => { cli.showHelp() })
    .alias('help', 'h')
    // .option('verbose', { alias: 'v', describe: 'verbose logging' })
    .demandCommand(1, 1, 'command required')
    .strictCommands()

  cli.wrap(Math.min(cli.terminalWidth(), 120))
  const argv = await cli.parse()
  console.log(argv)
}

async function init ({ name }) {
  // authenticate
  // new site (--name or interactive or null)
  // return new subdomain+deploy_key
}

async function configure ({ site, domain }) {
  // authenticate
  // verify domain
  // set domain (--domain or interactive or error)
  // print ok
}

async function deploy ({ site }) {
  // authenticate user or deploykey
  // siteId flag or env var or interactive
  // tarball [path], --exclude or interactive
  // deploy
  // if --promote also promote
  // if --wait also wait (if interactive wait by default)
}

async function promote (params) {
  // authenticate user or deploykey
  // siteId/deployId
}
