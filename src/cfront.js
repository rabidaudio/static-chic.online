const {
  CloudFrontClient,
  CreateInvalidationForDistributionTenantCommand,
  GetInvalidationForDistributionTenantCommand
} = require('@aws-sdk/client-cloudfront')

const logger = require('./logger').getLogger()

const client = new CloudFrontClient()

exports.invalidate = async (distributionTenantId) => {
  const params = {
    Id: distributionTenantId,
    InvalidationBatch: {
      Paths: {
        Items: ['/*'],
        Quantity: 1
      },
      CallerReference: new Date().toISOString()
    }
  }
  logger.http(`cloudfront: create invalidation ${distributionTenantId}`)
  const { Invalidation } = await client.send(new CreateInvalidationForDistributionTenantCommand(params))
  return Invalidation
}

exports.getInvalidation = async (distributionTenantId, invalidationId) => {
  logger.http(`cloudfront: get invalidation ${distributionTenantId} ${invalidationId}`)
  const { Invalidation } = await client.send(new GetInvalidationForDistributionTenantCommand({
    DistributionTenantId: distributionTenantId,
    Id: invalidationId
  }))
  return Invalidation
}
