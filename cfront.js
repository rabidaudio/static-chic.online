const {
  CloudFrontClient,
  CreateInvalidationForDistributionTenantCommand,
  GetInvalidationForDistributionTenantCommand
} = require('@aws-sdk/client-cloudfront')

const client = new CloudFrontClient()

exports.invalidate = async (distributionTenantId) => {
  const cmd = new CreateInvalidationForDistributionTenantCommand({
    Id: distributionTenantId,
    InvalidationBatch: {
      Paths: {
        Items: ['/*'],
        Quantity: 1
      },
      CallerReference: new Date().toISOString()
    }
  })
  const { Invalidation } = await client.send(cmd)
  return Invalidation
}

exports.getInvalidation = async (distributionTenantId, invalidationId) => {
  const cmd = new GetInvalidationForDistributionTenantCommand({
    DistributionTenantId: distributionTenantId,
    Id: invalidationId
  })
  const { Invalidation } = await client.send(cmd)
  return Invalidation
}
