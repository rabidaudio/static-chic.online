const { DynamoDBClient, ResourceNotFoundException } = require('@aws-sdk/client-dynamodb')

const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} = require('@aws-sdk/lib-dynamodb')

const client = new DynamoDBClient()
const docClient = DynamoDBDocumentClient.from(client)

const tablePrefix = process.env.TABLE_PREFIX

exports.create = async (table, data) => {
  const command = new PutCommand({
    TableName: `${tablePrefix}-${table}`,
    Item: data
  })
  await docClient.send(command)
  return data
}

exports.show = async (table, key) => {
  const command = new GetCommand({
    TableName: `${tablePrefix}-${table}`,
    Key: key // e.g. { userId }
  })
  try {
    const { Item } = await docClient.send(command)
    return Item
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return null
    }
    throw err
  }
}

// Return an efficient page of results by filtering to partitionKey and ordering
// by sortKey descending.
// TODO: support pagination
exports.query = async (table, partition, { asc, idx }) => {
  const [partitionKey, partitionValue] = Object.entries(partition)[0]
  const params = {
    TableName: `${tablePrefix}-${table}`,
    Limit: 100,
    ScanIndexForward: asc,
    ExpressionAttributeValues: {
      ':v1': partitionValue
    },
    KeyConditionExpression: `${partitionKey} = :v1`
  }
  if (idx) params.IndexName = idx
  const command = new QueryCommand(params)
  const { Items } = await docClient.send(command)
  return Items || []
}
