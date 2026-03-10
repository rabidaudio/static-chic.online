const {
  S3Client,
  GetObjectCommand,
  ListObjectsCommand,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')

const logger = require('./logger').getLogger()

const client = new S3Client()

const bucketName = process.env.BUCKET_NAME

exports.upload = async (path, file, { contentType } = {}) => {
  const params = {
    Bucket: bucketName,
    Key: path,
    Body: file
  }
  if (contentType) params.ContentType = contentType
  logger.verbose(`s3: upload s3://${bucketName}/${path}`)
  const task = new Upload({ client, params })
  await task.done()
}

exports.download = async (path) => {
  logger.verbose(`s3: download s3://${bucketName}/${path}`)
  const res = await client.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: path
  }))
  return await res.Body.transformToWebStream()
}

exports.deleteRecursive = async (path) => {
  let Marker
  while (true) {
    logger.verbose(`s3: ls s3://${bucketName}/${path}`)
    const { Contents, IsTruncated } = await client.send(new ListObjectsCommand({
      Bucket: bucketName,
      Prefix: path,
      Marker
    }))

    if (!Contents) return // empty directory

    const keys = Contents.map((c) => c.Key)
    Marker = keys[keys.length - 1]
    logger.verbose(`s3: rm s3://${bucketName}/${path}`, keys)
    await client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: keys.map((key) => ({ Key: key })) }
    }))

    if (!IsTruncated) return
  }
}
