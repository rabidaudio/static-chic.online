/* global describe, it */

const path = require('node:path')
const { buffer } = require('node:stream/consumers')

const { expect } = require('chai')
const axios = require('axios')

const { createTarball } = require('../app')

// NOTE: these tests are integration tests run against a development deploy
// (sls:stage=dev) of the actual app
const api = axios.create({
  baseURL: process.env.TEST_HOST,
  timeout: 10000
})

describe('API', () => {
  // describe('Sites', () => {
  //     describe('create', () => {
  //         it('should create a site', async () => {
  //             const req = await api.post('/sites')
  //         })
  //     })

  //     describe('show', () => {
  //         it('should show the site data', async () => {
  //             const req = await api.get('/users/okay_sure_cool')
  //             const user = req.data
  //             expect(user.userId).to.equal('okay_sure_cool')
  //         })
  //     })
  // })

  describe('Deployments', () => {
    describe('create', () => {
      it('should create a new deployment', async () => {
        const testTarball = await createTarball(path.join(__dirname, '..', 'example-dist'))
        const data = await buffer(testTarball)
        const res = await api.post('/sites/prison-mentor-ydd8c/deployments', data, {
          headers: {
            'Content-Type': 'application/gzip'
          }
        })
        expect(res.status).to.equal(200)
        expect(res.data.status).to.equal('OK')
        const deployment = res.data.data
        expect(deployment.siteId).to.equal('prison-mentor-ydd8c')
        expect(deployment.deploymentId).not.to.equal(null)
      })
    })

    describe('list', () => {
      it('should return a list of deployments', async () => {
        const res = await api.get('/sites/prison-mentor-ydd8c/deployments')
        expect(res.status).to.equal(200)
        expect(res.data.status).to.equal('OK')
        const deployments = res.data.data
        expect(deployments.length).to.equal(res.data.pagination.count)
        expect(deployments[0].deploymentId).to.match(/^[0-9a-f]{24}$/)
        expect(deployments[0].siteId).to.equal('prison-mentor-ydd8c')
      })
    })

    describe('promote', () => {
      it('should make the deployment live for the site', async () => {
        const res = await api.post('/sites/prison-mentor-ydd8c/deployments/0000019cc63c89f5001bda59/promote')
        expect(res.status).to.equal(200)
        expect(res.data.status).to.equal('OK')
        expect(res.data.data.siteId).to.equal('prison-mentor-ydd8c')
        expect(res.data.data.currentDeployment).to.equal('0000019cc63c89f5001bda59')
      })
    })
  })
})
