const express = require('express')
const serverless = require('serverless-http')

const db = require('./db')

const app = express()

app.use(express.json())

app.get('/users/:userId', async (req, res) => {
  try {
    const user = await db.getUser(req.params.userId)
    if (user) {
      const { userId, name } = user
      res.json({ userId, name })
    } else {
      res
        .status(404)
        .json({ error: 'Could not find user with provided "userId"' })
    }
  } catch (error) {
    console.log(error)
    res.status(500).json({ error: 'Could not retrieve user' })
  }
})

app.post('/users', async (req, res) => {
  const { userId, name } = req.body
  if (typeof userId !== 'string') {
    res.status(400).json({ error: '"userId" must be a string' })
  } else if (typeof name !== 'string') {
    res.status(400).json({ error: '"name" must be a string' })
  }

  try {
    const user = await db.createUser({ userId, name })
    res.json(user)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Could not create user' })
  }
})

app.use((req, res, next) => {
  return res.status(404).json({
    error: 'Not Found'
  })
})

exports.handler = serverless(app)
