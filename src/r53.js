const {
  Route53Client,
  ChangeResourceRecordSetsCommand
} = require('@aws-sdk/client-route-53')

const logger = require('./logger').getLogger()

const client = new Route53Client()

const getRecordSet = (domain) => ({
  Name: domain,
  Type: 'CNAME',
  TTL: 300,
  ResourceRecords: [
    { Value: process.env.DISTRIBUTION_DOMAIN }
  ]
})

const changeResource = async (operation, domain) => {
  const params = {
    HostedZoneId: process.env.HOSTED_ZONE_ID,
    ChangeBatch: {
      Comment: `${operation} ${domain}`,
      Changes: [
        {
          Action: operation,
          ResourceRecordSet: getRecordSet(domain)
        }
      ]
    }
  }
  logger.http(`route53: ${operation} ${domain}`)
  const { Id, Status } = await client.send(new ChangeResourceRecordSetsCommand(params))
  return { id: Id, status: Status }
}

module.exports = {
  createSubdomain: async (domain) => changeResource('UPSERT', domain),
  deleteSubdomain: async (domain) => changeResource('DELETE', domain)
}
