const winston = require('winston')

let _logger = null

exports.configure = ({ level, pretty } = {}) => {
  _logger = winston.createLogger({
    levels: winston.config.npm.levels,
    format: pretty
      ? winston.format.combine(
        winston.format.colorize({ message: true, level: true }),
        winston.format.errors(),
        winston.format((info, opts) => {
          return `${info.message}`
        })()
      )
      : winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors(),
        winston.format.simple()
      ),
    transports: [
      new winston.transports.Console({
        level: (level || 'warn'),
        stderrLevels: ['info', 'http', 'verbose']
      })
    ]
  })
}

exports.getLogger = () => {
  if (!_logger) throw new Error('must `configure` the logger before use')
  return _logger
}
