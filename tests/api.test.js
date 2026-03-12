/* eslint-disable no-unused-expressions */
const path = require('node:path')
const { buffer } = require('node:stream/consumers')

const { expect } = require('chai')
const chalk = require('chalk')
const prompts = require('@inquirer/prompts')

const { runTests, Api } = require('./utils')
const { createTarball } = require('../src/files')

const api = new Api()

async function testRunning (ctx) {
  const res = await api.GET('/')
  expect(res.status).to.equal(200)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.app).to.exist
  expect(res.json.data.distro).to.match(/.+\.cloudfront\.net/)
}

async function testAuth (ctx) {
  let res = await api.POST('/signup?provider=github')
  expect(res.status).to.equal(200)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.authReqId).to.exist
  expect(res.json.data.authorizationUrl).to.match(/^https:\/\/github.com\/login\/oauth\/authorize/)
  ctx.authReqId = res.json.data.authReqId

  res = await api.GET(`/signup/${ctx.authReqId}`)
  expect(res.status).to.equal(200)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.authReqId).to.equal(ctx.authReqId)
  expect(res.json.data.state).to.equal('pending')

  if (!res.wasCached) {
    console.log(chalk.bold('open ') + res.json.data.authorizationUrl)
    const authorized = await prompts.confirm({ message: 'authorized?' })
    expect(authorized).to.be.true
  }

  res = await api.GET(`/signup/${ctx.authReqId}`)
  expect(res.status).to.equal(200)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.authReqId).to.equal(ctx.authReqId)
  expect(res.json.data.state).to.equal('authorized')
  expect(res.json.data.userToken).to.exist
  ctx.userToken = res.json.data.userToken

  api.set('Authorization', `Basic ${ctx.userToken}`)
  res = await api.GET('/')
  expect(res.status).to.equal(200)
  expect(res.json.data.userId).to.match(/github_[0-9]+/)
  ctx.userId = res.json.data.userId
}

// TODO test failed auth paths

async function testSite (ctx) {
  api.set('Authorization', `Basic ${ctx.userToken}`)

  let res = await api.POST('/sites', {
    body: JSON.stringify({ name: 'Test Site' }),
    headers: {
      'Content-Type': 'application/json'
    }
  })
  expect(res.status).to.equal(201)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.siteId).to.exist
  ctx.siteId = res.json.data.siteId
  expect(res.json.data.name).to.equal('Test Site')
  expect(res.json.data.userId).to.equal(ctx.userId)
  expect(res.json.data.createdAt).to.satisfy((d) => new Date(d).getTime() > 0, 'be an iso timestamp')
  expect(res.json.data.currentDeployment).not.to.exist
  expect(res.json.data.deployedAt).not.to.exist
  expect(res.json.data.deployKey).to.match(/^dk_[A-Za-z0-9-_]+$/)
  ctx.deployKey = res.json.data.deployKey
  expect(res.json.data.deployKeyCreatedAt).to.satisfy((d) => new Date(d).getTime() > 0, 'be an iso timestamp')
  expect(res.json.data.deployKeyLastUsedAt).not.to.exist

  res = await api.GET(`/sites/${ctx.siteId}`)
  expect(res.status).to.equal(200)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.siteId).to.equal(ctx.siteId)
  expect(res.json.data.deployKey).to.match(/^dk_[A-Za-z0-9-_]{5}x+$/, 'be obfuscated')

  res = await api.GET('/sites')
  expect(res.status).to.equal(200)
  expect(res.json.status).to.equal('OK')
  expect(res.json.data.length).to.be.greaterThanOrEqual(1)
  expect(res.json.pagination.count).to.equal(res.json.data.length)
  expect(res.json.data[0].siteId).to.equal(ctx.siteId) // ordered by most recent
  expect(res.json.data[0].deployKey).to.match(/^dk_[A-Za-z0-9-_]{5}x+$/, 'be obfuscated')
}

// TODO: custom domain: before and after deploy, with and without domain

async function testDeploy (ctx) {
  let res
  for (const auth of [`Basic ${ctx.userToken}`, `Bearer ${ctx.deployKey}`]) {
    api.set('Authorization', auth)

    // create dep 1
    const tarball1 = await createTarball(path.join(__dirname, '..', 'example-dist'), { exclude: ['images'] })
    res = await api.POST(`/sites/${ctx.siteId}/deployments`, {
      body: (await buffer(tarball1)),
      headers: {
        'Content-Type': 'application/gzip'
      }
    })
    expect(res.status).to.equal(201)
    expect(res.json.status).to.equal('OK')
    expect(res.json.data.deploymentId).to.match(/^d_[a-z0-f]+$/)
    expect(res.json.data.siteId).to.equal(ctx.siteId)
    expect(res.json.data.createdAt).to.satisfy((d) => new Date(d).getTime() > 0, 'be an iso timestamp')
    expect(res.json.data.message).not.to.exist
    ctx.deploymentId1 = res.json.data.deploymentId

    // check dep 1
    res = await api.GET(`/sites/${ctx.siteId}/deployments/${ctx.deploymentId1}`)
    expect(res.status).to.equal(200)
    expect(res.json.status).to.equal('OK')
    expect(res.json.data.deploymentId).to.equal(ctx.deploymentId1)

    // promote dep 1
    res = await api.POST(`/sites/${ctx.siteId}/deployments/${ctx.deploymentId1}/promote`)
    expect(res.status).to.equal(200)
    expect(res.json.status).to.equal('OK')
    expect(res.json.data.siteId).to.equal(ctx.siteId)
    // TODO: show if deployed

    // check site status
    res = await api.GET(`/sites/${ctx.siteId}`)
    expect(res.status).to.equal(200)
    expect(res.json.status).to.equal('OK')
    expect(res.json.data.currentDeployment).to.equal(ctx.deploymentId1)
    expect(res.json.data.deployedAt).to.satisfy((d) => new Date(d).getTime() > 0, 'be an iso timestamp')

    if (!res.wasCached) {
      console.log(api.host.replace('api.', `${ctx.siteId}.sites.`))
      await prompts.confirm({ message: 'deployed?' })
    }

    // create dep 2
    const tarball2 = await createTarball(path.join(__dirname, '..', 'example-dist'), { exclude: ['*.txt'] })
    res = await api.POST(`/sites/${ctx.siteId}/deployments?message=testmessage`, {
      body: (await buffer(tarball2)),
      headers: {
        'Content-Type': 'application/gzip'
      }
    })
    expect(res.status).to.equal(201)
    expect(res.json.data.deploymentId).to.match(/^d_[a-z0-f]+$/)
    expect(res.json.data.message).to.equal('testmessage')
    ctx.deploymentId2 = res.json.data.deploymentId

    // check site status
    res = await api.GET(`/sites/${ctx.siteId}`)
    expect(res.status).to.equal(200)
    expect(res.json.data.currentDeployment).to.equal(ctx.deploymentId1)

    // promote 2
    res = await api.POST(`/sites/${ctx.siteId}/deployments/${ctx.deploymentId2}/promote`)
    expect(res.status).to.equal(200)
    expect(res.json.status).to.equal('OK')

    if (!res.wasCached) {
      console.log(api.host.replace('api.', `${ctx.siteId}.sites.`))
      const deployed = await prompts.confirm({ message: 'deployed?' })
      expect(deployed).to.be.true
    }

    // check site status
    res = await api.GET(`/sites/${ctx.siteId}`)
    expect(res.status).to.equal(200)
    expect(res.json.data.currentDeployment).to.equal(ctx.deploymentId2)

    // re-promote existing deploy
    res = await api.POST(`/sites/${ctx.siteId}/deployments/${ctx.deploymentId2}/promote`)
    expect(res.status).to.equal(202)
    expect(res.json.status).to.equal('OK')

    // rollback
    res = await api.POST(`/sites/${ctx.siteId}/deployments/${ctx.deploymentId1}/promote`)
    expect(res.status).to.equal(200)
    expect(res.json.status).to.equal('OK')

    if (!res.wasCached) {
      console.log(api.host.replace('api.', `${ctx.siteId}.sites.`))
      const deployed = await prompts.confirm({ message: 'deployed?' })
      expect(deployed).to.be.true
    }

    // check site status
    res = await api.GET(`/sites/${ctx.siteId}`)
    expect(res.status).to.equal(200)
    expect(res.json.data.currentDeployment).to.equal(ctx.deploymentId1)
  }
}

async function testUnauthorized (ctx) {
  api.clear('Authorization')

  const tests = async function * () {
    yield await api.GET('/sites')
    yield await api.POST('/sites')
    yield await api.GET(`/sites/${ctx.siteId}`)
    yield await api.PUT(`/sites/${ctx.siteId}`)
    yield await api.POST(`/sites/${ctx.siteId}/deployKey/regenerate`)
    yield await api.DELETE(`/sites/${ctx.siteId}`)
  }

  for await (const res of tests) {
    expect(res.status).to.equal(401)
    expect(res.json.status).to.equal('ERROR')
    expect(res.json.error.message).to.match(/Authorization Failed/)
  }
}

// async function testDeployKey (ctx) {
// revoke
// print once
// new key works
// old key doesnt
// }

// async function testDelete (ctx) {
//   // delete site
//   // test get after
// }

runTests(testRunning, testAuth, testSite, testDeploy, testUnauthorized)
