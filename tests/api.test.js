/* global describe, it */

const path = require('node:path')
const { buffer } = require('node:stream/consumers')

const { expect } = require('chai')
const fetch = require('fetch-vcr')

const { createTarball } = require('../src/app')

// NOTE: these tests are integration tests run against a development deploy
// (sls:stage=dev) of the actual app. They are recorded using VCR into
// fixtures and played back.
const api = process.env.TEST_HOST || 'https://dev.static-chic.online'
fetch.configure({
  fixturePath: path.join(__dirname, '_fixtures'),
  mode: process.env.VCR_MODE || 'cache'
})

describe('API', () => {
  describe('Deployments', () => {
    describe('create', () => {
      it('should create a new deployment', async () => {
        const testTarball = await createTarball(path.join(__dirname, '..', 'example-dist'))
        const data = await buffer(testTarball)
        const res = await fetch(`${api}/sites/ride-impede-dwoxv/deployments`, {
          method: 'POST',
          body: data,
          headers: {
            'Content-Type': 'application/gzip'
          }
        })
        expect(res.status).to.equal(200)
        const body = await res.json()
        expect(body.status).to.equal('OK')
        const deployment = body.data
        expect(deployment.siteId).to.equal('ride-impede-dwoxv')
        expect(deployment.deploymentId).not.to.equal(null)
      })
    })

    describe('list', () => {
      it('should return a list of deployments', async () => {
        const res = await fetch(`${api}/sites/ride-impede-dwoxv/deployments`)
        expect(res.status).to.equal(200)
        const body = await res.json()
        expect(body.status).to.equal('OK')
        const deployments = body.data
        expect(deployments.length).to.equal(body.pagination.count)
        expect(deployments[0].deploymentId).to.match(/^[0-9a-f]{24}$/)
        expect(deployments[0].siteId).to.equal('ride-impede-dwoxv')
      })
    })

    describe('promote', () => {
      it('should make the deployment live for the site', async () => {
        const res = await fetch(`${api}/sites/ride-impede-dwoxv/deployments/0000019cc6eca98150a73ef6/promote`, {
          method: 'POST'
        })
        expect(res.status).to.equal(200)
        const body = await res.json()
        expect(body.status).to.equal('OK')
        expect(body.data.siteId).to.equal('ride-impede-dwoxv')
        expect(body.data.currentDeployment).to.equal('0000019cc6eca98150a73ef6')
      })
    })
  })
})
