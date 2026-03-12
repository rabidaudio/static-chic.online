const {
  CloudFrontClient,
  CreateInvalidationForDistributionTenantCommand,
  GetInvalidationForDistributionTenantCommand,
  CreateDistributionTenantCommand,
  UpdateDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  GetDistributionTenantCommand
} = require('@aws-sdk/client-cloudfront')

const logger = require('./logger').getLogger()

const client = new CloudFrontClient()

const tenantParams = ({ siteId, baseDomain, customDomain }) => {
  const params = {
    Enabled: true,
    DistributionId: process.env.DISTRIBUTION_ID,
    Domains: [{ Domain: baseDomain }],
    ConnectionGroupId: process.env.CONNECTION_GROUP_ID,
    Tags: [
      { Name: 'app', Value: process.env.APP_NAME },
      { Name: 'stage', Value: process.env.STAGE }
    ],
    Parameters: [
      { Name: 'siteId', Value: siteId }
    ]
  }
  if (customDomain) {
    params.Domains.push({ Domain: customDomain })
    params.ManagedCertificateRequest = {
      PrimaryDomainName: customDomain,
      ValidationTokenHost: 'cloudfront'
    }
  }
  return params
}

module.exports.createTenant = async ({ siteId, baseDomain, customDomain }) => {
  const params = {
    ...tenantParams({ siteId, baseDomain, customDomain }),
    Name: siteId
  }
  logger.http(`cloudfront: create tenant ${siteId}`, params)
  const { DistributionTenant, ETag } = await client.send(new CreateDistributionTenantCommand(params))
  return { tenant: DistributionTenant, etag: ETag }
}

module.exports.updateTenant = async ({ tenantId, siteId, baseDomain, customDomain, etag }) => {
  const params = {
    ...tenantParams({ siteId, baseDomain, customDomain }),
    Id: tenantId,
    IfMatch: etag
  }
  logger.http(`cloudfront: update tenant ${siteId}`, params)
  const { DistributionTenant, ETag } = await client.send(new UpdateDistributionTenantCommand(params))
  return { tenant: DistributionTenant, etag: ETag }
}

module.exports.getTenant = async (tenantId) => {
  logger.http(`cloudfront: get tenant ${tenantId}`)
  const { DistributionTenant, ETag } = await client.send(new GetDistributionTenantCommand({ Identifier: tenantId }))
  return { tenant: DistributionTenant, etag: ETag }
}

module.exports.deleteTenant = async ({ tenantId, etag }) => {
  logger.http(`cloudfront: delete tenant ${tenantId}`)
  await client.send(new DeleteDistributionTenantCommand({ Id: tenantId, IfMatch: etag }))
}

module.exports.invalidate = async (distributionTenantId) => {
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

module.exports.getInvalidation = async (distributionTenantId, invalidationId) => {
  logger.http(`cloudfront: get invalidation ${distributionTenantId} ${invalidationId}`)
  const { Invalidation } = await client.send(new GetInvalidationForDistributionTenantCommand({
    DistributionTenantId: distributionTenantId,
    Id: invalidationId
  }))
  return Invalidation
}
