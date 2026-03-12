require('@dotenvx/dotenvx').config({ quiet: true })

const port = process.env.PORT || 4000
process.env.HOST = `http://localhost:${port}`

const { server } = require('./server')

server.listen(port, () => console.log(`Dev server running: ${process.env.HOST}`))
