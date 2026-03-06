require('dotenv').config()

const { expect } = require('chai')
const axios = require("axios")

// NOTE: these tests are integration tests run against a development deploy
// (sls:stage=dev) of the actual app
const api = axios.create({
    baseURL: process.env.TEST_HOST,
    timeout: 10000,
})

describe('API', () => {
    describe('Sites', () => {
        describe('create', () => {
            it('should create a site', async () => {
                const req = await api.get('/users/okay_sure_cool')
                const user = req.data
                expect(user.userId).to.equal('okay_sure_cool')
            })
        })

        // describe('show', () => {

        // })
    })

    // describe('Deployments', () => {
        
    //     describe('list', () => {

    //     })

    //     describe('create', () => {

    //     })
    // })
})
