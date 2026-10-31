import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Readers, one record per passphrase: { archive: { storyId: archivedAt }, createdAt }.
 * DynamoDB in Lambda (item id "user#<sha256>"), a JSON file when LOCAL_ARCHIVE_FILE is set.
 */
export function createUsers() {
  const file = process.env.LOCAL_ARCHIVE_FILE;
  if (file) {
    const load = async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return {};
      }
    };
    const save = async (all) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(all, null, 1));
    };
    return {
      async get(key) {
        return (await load())[key] ?? null;
      },
      async create(key, record) {
        const all = await load();
        if (all[key]) return false;
        all[key] = record;
        await save(all);
        return true;
      },
      async save(key, record) {
        const all = await load();
        all[key] = record;
        await save(all);
      },
    };
  }

  const table = process.env.TABLE;
  const ddb = import('@aws-sdk/client-dynamodb').then((m) => ({ m, client: new m.DynamoDBClient({}) }));
  const toItem = (key, record) => ({ id: { S: `user#${key}` }, data: { S: JSON.stringify(record) } });
  return {
    async get(key) {
      const { m, client } = await ddb;
      const res = await client.send(new m.GetItemCommand({ TableName: table, Key: { id: { S: `user#${key}` } }, ConsistentRead: true }));
      return res.Item ? JSON.parse(res.Item.data.S) : null;
    },
    async create(key, record) {
      const { m, client } = await ddb;
      try {
        await client.send(new m.PutItemCommand({
          TableName: table, Item: toItem(key, record), ConditionExpression: 'attribute_not_exists(id)',
        }));
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },
    async save(key, record) {
      const { m, client } = await ddb;
      await client.send(new m.PutItemCommand({ TableName: table, Item: toItem(key, record) }));
    },
  };
}
