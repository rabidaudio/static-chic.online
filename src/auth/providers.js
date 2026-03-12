const GithubAuthProvider = require('./github')

module.exports = {
  findProviderByName: (name) => {
    switch (name) {
      case 'github': return new GithubAuthProvider()
      default: throw new Error(`Unknown auth provider: ${name}`)
    }
  }
}
