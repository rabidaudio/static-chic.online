const winston = require('winston')

let _logger = null

const errorFormatter = winston.format((info, _opts) => {
  if (info instanceof Error || info.stack) {
    return { ...info, message: (info.message || '') + '\n' + info.stack }
  }
  return info
})

exports.configure = ({ level, pretty } = {}) => {
  const formats = [
    errorFormatter(),
    winston.format.simple()
  ]
  if (pretty) {
    formats.unshift(winston.format.colorize({
      level: true,
      colors: {
        error: 'bgRed',
        warn: 'bgYellow',
        info: 'blue',
        http: 'gray',
        verbose: 'magenta'
      }
    }))
  }
  _logger = winston.createLogger({
    levels: winston.config.npm.levels,
    level,
    format: winston.format.combine(...formats),
    transports: [
      new winston.transports.Console({
        stderrLevels: ['info', 'http', 'verbose']
      })
    ]
  })
}

exports.getLogger = () => {
  if (!_logger) throw new Error('must `configure` the logger before use')
  return _logger
}
