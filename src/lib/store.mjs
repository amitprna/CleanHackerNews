import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** JSON blob storage: S3 in Lambda, a folder when LOCAL_DATA_DIR is set. */
export function createStore() {
  const dir = process.env.LOCAL_DATA_DIR;
  if (dir) {
    return {
      async readJson(key) {
        try {
          return JSON.parse(await readFile(join(dir, key), 'utf8'));
        } catch (e) {
          if (e.code === 'ENOENT') return null;
          throw e;
        }
      },
      async writeJson(key, value) {
        const path = join(dir, key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(value, null, 1));
      },
    };
  }

  const bucket = process.env.BUCKET;
  const s3 = import('@aws-sdk/client-s3').then((m) => ({ m, client: new m.S3Client({}) }));
  return {
    async readJson(key) {
      const { m, client } = await s3;
      try {
        const res = await client.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse(await res.Body.transformToString());
      } catch (e) {
        if (e.name === 'NoSuchKey') return null;
        throw e;
      }
    },
    async writeJson(key, value, { cacheControl = 'no-cache' } = {}) {
      const { m, client } = await s3;
      await client.send(
        new m.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(value),
          ContentType: 'application/json; charset=utf-8',
          CacheControl: cacheControl,
        }),
      );
    },
  };
}
