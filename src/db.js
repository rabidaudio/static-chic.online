const { DynamoDBClient, ResourceNotFoundException } = require('@aws-sdk/client-dynamodb')

const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb')

const logger = require('./logger').getLogger()

const client = new DynamoDBClient()
const docClient = DynamoDBDocumentClient.from(client)

const tablePrefix = process.env.TABLE_PREFIX

module.exports.put = async (table, data) => {
  const command = new PutCommand({
    TableName: `${tablePrefix}-${table}`,
    Item: data
  })
  logger.http(`put ${table}`)
  await docClient.send(command)
  return data
}

module.exports.get = async (table, keys) => {
  const command = new GetCommand({
    TableName: `${tablePrefix}-${table}`,
    Key: keys // e.g. { userId }
  })
  try {
    logger.http(`dynamo: get ${table}`, keys)
    const { Item } = await docClient.send(command)
    return Item
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      logger.info(`get ${table}: not found`, keys)
      return null
    }
    throw err
  }
}

// Return an efficient page of results by filtering to partitionKey and ordering
// by sortKey descending.
// TODO: support pagination
module.exports.query = async (table, partition, { asc, idx } = {}) => {
  const [partitionKey, partitionValue] = Object.entries(partition)[0]
  const params = {
    TableName: `${tablePrefix}-${table}`,
    Limit: 100,
    ScanIndexForward: asc || false,
    ExpressionAttributeValues: {
      ':v1': partitionValue
    },
    KeyConditionExpression: `${partitionKey} = :v1`
  }
  if (idx) params.IndexName = idx
  logger.http(`dynamo: query ${table}: ${partitionKey} = ${partitionValue} ${asc ? 'asc' : 'desc'}`)
  const { Items } = await docClient.send(new QueryCommand(params))
  logger.http(`dynamo: query ${table} results: ${(Items || []).length}`)
  return Items || []
}

// returns an async generator which will page through the whole table.
// To get a full array, use `await Array.fromAsync(scan(...))`
module.exports.scan = async function * (table, filters = {}) {
  let startKey
  const filterExpressions = []
  const params = {
    TableName: `${tablePrefix}-${table}`
  }
  const filterEntries = Object.entries(filters)
  if (filterEntries.length > 0) {
    params.ExpressionAttributeNames = {}
    params.ExpressionAttributeValues = {}
    for (const i in filterEntries) {
      const [key, val] = filterEntries[i]
      filterExpressions.push(`#${i} = :v${i}`)
      params.ExpressionAttributeNames[`#${i}`] = key
      params.ExpressionAttributeValues[`:v${i}`] = val
    }
    params.FilterExpression = filterExpressions.join(' and ')
  }
  logger.http(`dynamo: scan ${table}`, params)
  while (true) {
    const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand({ ...params, ExclusiveStartKey: startKey }))
    logger.http(`dynamo: scan ${table} results: ${Items.length}`)
    for (const item of Items) {
      yield item
    }
    if (LastEvaluatedKey === undefined || Items.length === 0) return
    startKey = LastEvaluatedKey
  }
}

module.exports.delete = async (table, keys) => {
  try {
    logger.http(`dynamo: delete ${table}`, keys)
    await docClient.send(new DeleteCommand({
      TableName: `${tablePrefix}-${table}`,
      Key: keys // e.g. { siteId, deploymentId }
    }))
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      logger.info(`delete ${table}: not found`, keys)
      return
    }
    throw err
  }
}
