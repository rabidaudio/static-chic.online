const {randomBytes } = require('node:crypto')

const namor = require('namor')

const db = require('./db')

// space size: 7948^2*(26+10)^5 = 3.8 quadrillion
// ~50% chance of collision ~62 million
const generateSiteId = () => {
    const name = namor.generate({ words: 2, salt: 5 })
    if (namor.valid_subdomain(name, { reserved: true })) return name
    return generateSiteId() // try again
}

const generateDeployKey = () => randomBytes(32).toString('base64')

exports.createUser = async ({ userId, name }) => {
    return await db.create('users', {
        userId,
        name,
        createdAt: new Date().toISOString()
    })
}

exports.getUser = async (userId) => {
    return await db.show('users', { userId })
}

// create a site. A site has a siteId which is
// a randomly generated subdomain like `estate-specify-07euk`,
// a deploy key used to authenticate deployments, a name,
// a userId which owns it.
exports.createSite = async ({ name, userId }) => {
    return await db.create('sites', {
        siteId: generateSiteId(),
        userId,
        name,
        deployKey: generateDeployKey(),
        createdAt: new Date().toISOString()
    })
}

exports.getSite = async (siteId) => {
    return await db.show('sites', { siteId })
}
