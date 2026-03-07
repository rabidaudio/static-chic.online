const {
  S3Client,
  GetObjectCommand,
  ListObjectsCommand,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')

const client = new S3Client()

const bucketName = process.env.TABLE_PREFIX

exports.upload = async (path, file) => {
  const params = {
    Bucket: bucketName,
    Key: path,
    Body: file
  }
  const task = new Upload({ client, params })
  await task.done()
}

exports.download = async (path) => {
  const res = await client.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: path
  }))
  return await res.Body.transformToWebStream()
}

exports.deleteRecursive = async (path) => {
  let Marker
  while (true) {
    const { Contents, IsTruncated } = await client.send(new ListObjectsCommand({
      Bucket: bucketName,
      Prefix: path,
      Marker
    }))

    if (!Contents) return // empty directory

    const keys = Contents.map((c) => c.Key)
    Marker = keys[keys.length - 1]
    await client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: keys.map((key) => ({ Key: key })) }
    }))

    if (!IsTruncated) return
  }
}
