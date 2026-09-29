import File from '../lib/util/file.js';
import { assert } from 'chai';
import * as testUtils from './utils.js';
import handler from '../lib/index.js';
import Asset from '../lib/metadataTypes/Asset.js';
import cache from '../lib/util/cache.js';
import Replace from '../lib/util/replaceContentBlockReference.js';
import { Util } from '../lib/util/util.js';

const poolPath = 'test/resources/9999999/asset/v1/content/assets/assets-pool.json';
const consumerKey = 'testNew_asset_withCBBK_preexisting';
const consumerFile = `deploy/testInstance/testBU/asset/block/${consumerKey}.asset-block-meta.html`;
const sharedBlock = {
    id: 7001,
    customerKey: 'shared-block-key',
    name: 'SharedBlock',
    memberId: 1111111,
    assetType: { id: 197, name: 'htmlblock' },
    category: { id: 4707, name: 'Content Builder', parentId: 0 },
    status: { id: 1, name: 'Draft' },
    sharingProperties: { sharedWith: [9999999], sharingType: 'view' },
};

/**
 * Supply shared-only API records without changing fixtures for other suites.
 *
 * @param {object[]} items shared assets
 */
async function setSharedItems(items) {
    const pool = await File.readJSON(poolPath);
    for (const key of Object.keys(pool)) {
        if (pool[key].queryScope === 'shared') {
            delete pool[key];
        } else {
            pool[key].queryScope = 'local';
        }
    }
    for (const item of items) {
        pool[item.id] = { body: item, queryScope: 'shared' };
    }
    await File.writeJSON(poolPath, pool);
}

/**
 * @param {string} expression reference to deploy
 * @returns {Promise.<object>} deployment result
 */
async function deployReference(expression) {
    await File.writeFile(consumerFile, expression);
    return handler.deploy('testInstance/testBU', { asset: [consumerKey] });
}

/**
 * @returns {object[]} asset write requests only
 */
function assetWrites() {
    return Object.values(testUtils.getAPIHistory())
        .flat()
        .filter(
            (request) =>
                ['post', 'patch', 'put', 'delete'].includes(request.method) &&
                /^\/asset\/v1\/content\/assets\/(?:\d+)?$/.test(request.url)
        );
}

/**
 * @param {object[]} items shared response
 */
function respondWith(items) {
    // Only the HTTP boundary is mocked: retrieval, normalization and indexing are real.
    Asset.client = /** @type {import('sfmc-sdk').default} */ (
        /** @type {unknown} */ ({
            rest: {
                post: async (url) => {
                    assert.equal(url, '/asset/v1/content/assets/query?scope=shared');
                    return { items, count: items.length, page: 1, pageSize: 50 };
                },
            },
        })
    );
}

/**
 * @param {string} expression expression to resolve
 * @returns {string[]} resolved dependency keys
 */
function resolve(expression) {
    const result = Replace.replaceReference(expression, 'consumer');
    return [result.match(/ContentBlockByKey\("([^"]+)"\)/)[1]];
}

describe('type: asset cross-BU dependencies', () => {
    beforeEach(async () => {
        testUtils.mockSetup();
        testUtils.mockSetup(true);
        const folderFile =
            'test/resources/9999999/dataFolder/retrieve-ContentTypeINasset,asset-shared-QAA-response.xml';
        const folders = await File.readFile(folderFile, 'utf8');
        await File.writeFile(
            folderFile,
            folders.replace('<Name>Content Builder</Name>', '<Name>Shared Content</Name>')
        );
    });
    afterEach(() => testUtils.mockReset());

    for (const [kind, argument] of [
        ['Key', '"shared-block-key"'],
        ['Name', String.raw`"Shared Content\SharedBlock"`],
        ['Id', '7001'],
    ]) {
        for (const language of ['amp', 'ssjs']) {
            it(`deploys shared ${kind} references in ${language} without writing the dependency`, async () => {
                await setSharedItems([sharedBlock]);
                const expression =
                    language === 'amp'
                        ? `%%=ContentBlockBy${kind}(${argument})=%%`
                        : `<script runat="server">Platform.Function.ContentBlockBy${kind}(${argument.replaceAll('\\', '\\\\')});</script>`;
                const result = await deployReference(expression);
                assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [consumerKey]);
                assert.equal(process.exitCode, 0);
                const writes = assetWrites();
                assert.lengthOf(writes, 1);
                assert.equal(JSON.parse(writes[0].data).customerKey, consumerKey);
                assert.include(JSON.parse(writes[0].data).content, `ContentBlockBy${kind}`);
                assert.equal(await File.readFile(consumerFile, 'utf8'), expression);
                assert.isUndefined(cache.getByKey('asset', 'shared-block-key'));
                const sharedRequests = testUtils
                    .getAPIHistory()
                    .post.filter(
                        (request) => request.url === '/asset/v1/content/assets/query?scope=shared'
                    );
                assert.lengthOf(sharedRequests, 2);
                assert.equal(sharedRequests[0].headers.Authorization, 'Bearer 9999999');
            });
        }
    }

    it('does not request shared assets when the reference is already in the local cache', async () => {
        const result = await deployReference(
            '%%=ContentBlockByKey("testExisting_asset_htmlblock")=%%'
        );
        assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [consumerKey]);
        assert.isEmpty(
            testUtils.getAPIHistory().post.filter((request) => request.url.includes('scope=shared'))
        );
    });

    it('resolves a sibling-owned shared folder by name', async () => {
        const folderFile =
            'test/resources/9999999/dataFolder/retrieve-ContentTypeINasset,asset-shared-QAA-response.xml';
        const folders = await File.readFile(folderFile, 'utf8');
        await File.writeFile(folderFile, folders.replace('<ID>1111111</ID>', '<ID>2222222</ID>'));
        await setSharedItems([{ ...sharedBlock, memberId: 2222222 }]);
        const result = await deployReference(
            String.raw`%%=ContentBlockByName("Shared Content\SharedBlock")=%%`
        );
        assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [consumerKey]);
        assert.lengthOf(assetWrites(), 1);
    });

    it('creates a package asset whose key also belongs to a shared asset without updating the shared ID', async () => {
        await setSharedItems([{ ...sharedBlock, customerKey: consumerKey }]);
        const result = await deployReference('<p>A local asset</p>');
        assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [consumerKey]);
        const writes = assetWrites();
        assert.lengthOf(writes, 1);
        assert.equal(writes[0].method, 'post');
        assert.notEqual(cache.getByKey('asset', consumerKey).id, 7001);
    });

    it('does not turn an exact shared ID into a self dependency when the package has the same key', async () => {
        await setSharedItems([{ ...sharedBlock, customerKey: consumerKey }]);
        const result = await deployReference('%%=ContentBlockById(7001)=%%');
        assert.deepEqual(Object.keys(result['testInstance/testBU']?.asset || {}), [consumerKey]);
        assert.lengthOf(assetWrites(), 1);
    });

    it('orders package dependencies alongside shared and local references', async () => {
        await setSharedItems([sharedBlock]);
        await File.writeFile(
            consumerFile,
            [
                '%%=ContentBlockByKey("shared-block-key")=%%',
                '%%=ContentBlockByKey("testExisting_asset_htmlblock")=%%',
                '%%=ContentBlockByKey("testNew_asset_htmlblock")=%%',
                '%%=ContentBlockById(7001)=%%',
            ].join('\n')
        );
        const result = await handler.deploy('testInstance/testBU', {
            asset: [consumerKey, 'testNew_asset_htmlblock'],
        });
        assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [
            'testNew_asset_htmlblock',
            consumerKey,
        ]);
        assert.deepEqual(
            assetWrites().map((request) => JSON.parse(request.data).customerKey),
            ['testNew_asset_htmlblock', consumerKey]
        );
    });

    it('skips a consumer with an ambiguous shared name', async () => {
        await setSharedItems([
            sharedBlock,
            { ...sharedBlock, id: 7002, customerKey: 'another-shared-key' },
        ]);
        const result = await deployReference(
            String.raw`%%=ContentBlockByName("Shared Content\SharedBlock")=%%`
        );
        assert.isEmpty(result['testInstance/testBU'].asset);
        assert.isEmpty(assetWrites());
        assert.equal(process.exitCode, 1);
    });

    it('does not reintroduce rejected consumers through package dependency ordering', async () => {
        await setSharedItems([sharedBlock, { ...sharedBlock, id: 7002, name: 'AnotherBlock' }]);
        await File.writeFile(consumerFile, '%%=ContentBlockByKey("shared-block-key")=%%');
        await File.writeFile(
            'deploy/testInstance/testBU/asset/block/testNew_asset_htmlblock.asset-block-meta.html',
            `%%=ContentBlockByKey("${consumerKey}")=%%`
        );
        const result = await handler.deploy('testInstance/testBU', {
            asset: [consumerKey, 'testNew_asset_htmlblock'],
        });
        assert.isEmpty(result['testInstance/testBU'].asset);
        assert.isEmpty(assetWrites());
    });

    it('deploys an exact shared ID even when its key is ambiguous', async () => {
        await setSharedItems([sharedBlock, { ...sharedBlock, id: 7002, name: 'AnotherBlock' }]);
        const result = await deployReference('%%=ContentBlockById(7001)=%%');
        assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [consumerKey]);
        assert.lengthOf(assetWrites(), 1);
    });

    it('rejects a dependency not shared with the target BU', async () => {
        await setSharedItems([{ ...sharedBlock, sharingProperties: { sharedWith: [2222222] } }]);
        const result = await deployReference('%%=ContentBlockByKey("shared-block-key")=%%');
        assert.isEmpty(result['testInstance/testBU'].asset);
        assert.isEmpty(assetWrites());
        assert.equal(process.exitCode, 1);
    });

    it('does not reuse revoked sharing from a previous deployment', async () => {
        await setSharedItems([sharedBlock]);
        const expression = '%%=ContentBlockByKey("shared-block-key")=%%';
        const first = await deployReference(expression);
        assert.deepEqual(Object.keys(first['testInstance/testBU'].asset), [consumerKey]);
        await setSharedItems([]);
        const second = await deployReference(expression);
        assert.isEmpty(second['testInstance/testBU'].asset);
        assert.lengthOf(assetWrites(), 1);
    });

    it('resolves shared dependencies on a later query page', async () => {
        const firstPage = Array.from({ length: 50 }, (_, index) => ({
            ...sharedBlock,
            id: 8000 + index,
            customerKey: `filler-${index}`,
            name: `Filler${index}`,
        }));
        // Object keys sort numerically: put the actual dependency after the first 50 records.
        await setSharedItems([...firstPage, { ...sharedBlock, id: 9001 }]);
        const result = await deployReference('%%=ContentBlockById(9001)=%%');
        assert.deepEqual(Object.keys(result['testInstance/testBU'].asset), [consumerKey]);
        const pages = testUtils
            .getAPIHistory()
            .post.filter((request) => request.url.endsWith('?scope=shared'))
            .map((request) => JSON.parse(request.data).page.page);
        assert.deepEqual(pages, [1, 2, 1]);
    });
});

describe('asset cross-BU reference preparation', () => {
    let originalClient;
    let originalBu;
    beforeEach(() => {
        testUtils.mockSetup();
        originalClient = Asset.client;
        originalBu = Asset.buObject;
        Asset.buObject = {
            mid: 9999999,
            eid: 1111111,
            credential: 'testInstance',
            businessUnit: 'testBU',
        };
        cache.initCache(Asset.buObject);
        cache.setMetadata('asset', {});
        cache.setMetadata('folder', {
            shared: { ID: 4707, Client: { ID: 1111111 }, Path: 'Content Builder' },
        });
        Util.OPTIONS.referenceFrom = ['key', 'name', 'id'];
        Util.OPTIONS.referenceTo = 'key';
    });
    afterEach(() => {
        Asset.client = originalClient;
        Asset.buObject = originalBu;
        testUtils.mockReset();
    });

    it('normalizes local categories without mutating server or package records', async () => {
        const local = { ...sharedBlock, memberId: 9999999 };
        cache.setMetadata('folder', {
            local: { ID: 4707, Client: { ID: 9999999 }, Path: 'Content Builder' },
        });
        cache.setMetadata('asset', { 'shared-block-key': local });
        respondWith([]);
        const before = structuredClone(local);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.deepEqual(resolve(String.raw`ContentBlockByName("Content Builder\SharedBlock")`), [
            'shared-block-key',
        ]);
        assert.deepEqual(local, before);
    });

    it('prefers the shared owner folder over a local folder with the same ID', async () => {
        cache.setMetadata('folder', {
            local: { ID: 4707, Client: { ID: 9999999 }, Path: 'Local Content' },
            shared: { ID: 4707, Client: { ID: 1111111 }, Path: 'Shared Content' },
        });
        respondWith([sharedBlock]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.deepEqual(resolve(String.raw`ContentBlockByName("Shared Content\SharedBlock")`), [
            'shared-block-key',
        ]);
        assert.throws(() => resolve(String.raw`ContentBlockByName("Local Content\SharedBlock")`));
    });

    it('does not use another owner folder when the shared owner folder is absent', async () => {
        cache.setMetadata('folder', {
            local: { ID: 4707, Client: { ID: 9999999 }, Path: 'Wrong Local Folder' },
        });
        respondWith([sharedBlock]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.deepEqual(resolve('ContentBlockById(7001)'), ['shared-block-key']);
        assert.throws(() =>
            resolve(String.raw`ContentBlockByName("Wrong Local Folder\SharedBlock")`)
        );
    });

    it('retains package ordering for a local asset also returned in shared scope', async () => {
        const local = { ...sharedBlock, memberId: 9999999 };
        cache.setMetadata('folder', {
            local: { ID: 4707, Client: { ID: 9999999 }, Path: 'Content Builder' },
        });
        cache.setMetadata('asset', { 'shared-block-key': local });
        respondWith([local]);
        await Asset._prepareDeployReferenceCache({ 'shared-block-key': local });
        await Asset._cacheSharedAssets();
        const dependencies = new Set();
        Replace.replaceReference('ContentBlockById(7001)', 'consumer', dependencies);
        assert.deepEqual([...dependencies], ['shared-block-key']);
    });

    it('keeps key and ID references usable when the shared folder is missing', async () => {
        cache.setMetadata('folder', {});
        respondWith([sharedBlock]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.deepEqual(resolve('ContentBlockByKey("shared-block-key")'), ['shared-block-key']);
        assert.deepEqual(resolve('ContentBlockById(7001)'), ['shared-block-key']);
        assert.throws(() => resolve(String.raw`ContentBlockByName("Content Builder\SharedBlock")`));
    });

    it('preserves local and package aliases while keeping exact shared IDs', async () => {
        const local = { ...sharedBlock, id: 6001 };
        cache.setMetadata('asset', { 'shared-block-key': local });
        const packaged = {
            ...sharedBlock,
            id: undefined,
            customerKey: 'package-key',
            name: 'PackageBlock',
            r__folder_Path: 'Content Builder',
        };
        respondWith([
            sharedBlock,
            { ...sharedBlock, id: 7002, customerKey: 'other-key', name: 'PackageBlock' },
        ]);
        await Asset._prepareDeployReferenceCache({ 'package-key': packaged });
        await Asset._cacheSharedAssets();
        assert.equal(Replace.assetCacheMap.key['shared-block-key'].id, 6001);
        assert.deepEqual(resolve(String.raw`ContentBlockByName("Content Builder\PackageBlock")`), [
            'package-key',
        ]);
        assert.deepEqual(resolve('ContentBlockById(7002)'), ['other-key']);
        assert.isUndefined(cache.getByKey('asset', 'other-key'));
    });

    for (const field of ['customerKey', 'name']) {
        it(`rejects ambiguous shared ${field} references but resolves exact IDs`, async () => {
            const duplicate = {
                ...sharedBlock,
                id: 7002,
                customerKey: 'other-key',
                name: 'OtherBlock',
                [field]: sharedBlock[field],
            };
            respondWith([sharedBlock, duplicate]);
            await Asset._prepareDeployReferenceCache({});
            await Asset._cacheSharedAssets();
            assert.deepEqual(resolve('ContentBlockById(7001)'), ['shared-block-key']);
            const expression =
                field === 'customerKey'
                    ? 'ContentBlockByKey("shared-block-key")'
                    : String.raw`ContentBlockByName("Content Builder\SharedBlock")`;
            try {
                resolve(expression);
                assert.fail('Expected ambiguous shared reference to fail');
            } catch (ex) {
                assert.include(ex.message, 'Ambiguous shared asset');
                assert.include(ex.message, '7001');
                assert.include(ex.message, '7002');
            }
        });
    }

    it('distinguishes identical shared names in different folders', async () => {
        respondWith([
            { ...sharedBlock, r__folder_Path: 'Shared Content/First' },
            {
                ...sharedBlock,
                id: 7002,
                customerKey: 'second-key',
                r__folder_Path: 'Shared Content/Second',
            },
        ]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.deepEqual(
            resolve(String.raw`ContentBlockByName("Shared Content\First\SharedBlock")`),
            ['shared-block-key']
        );
        assert.deepEqual(
            resolve(String.raw`ContentBlockByName("Shared Content\Second\SharedBlock")`),
            ['second-key']
        );
    });

    it('deduplicates repeated shared records with the same ID', async () => {
        respondWith([sharedBlock, sharedBlock]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.deepEqual(resolve('ContentBlockById(7001)'), ['shared-block-key']);
    });

    it('clears references when switching target BUs', async () => {
        respondWith([sharedBlock]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        Asset.buObject = { ...Asset.buObject, mid: 2222222 };
        cache.initCache(Asset.buObject);
        cache.setMetadata('asset', {});
        respondWith([]);
        await Asset._prepareDeployReferenceCache({});
        await Asset._cacheSharedAssets();
        assert.throws(() => resolve('ContentBlockById(7001)'));
    });

    for (const status of [403, 500]) {
        it(`aborts asset upsert on shared query ${status} with target BU context`, async () => {
            const cause = new Error(`HTTP ${status}`);
            Asset.client = /** @type {import('sfmc-sdk').default} */ (
                /** @type {unknown} */ ({
                    rest: {
                        post: async (url) => {
                            assert.equal(url, '/asset/v1/content/assets/query?scope=shared');
                            throw cause;
                        },
                    },
                })
            );
            await File.outputFile(consumerFile, '%%=ContentBlockByKey("shared-block-key")=%%');
            try {
                await Asset.upsert(
                    {
                        [consumerKey]: {
                            customerKey: consumerKey,
                            name: consumerKey,
                            assetType: { id: 197, name: 'htmlblock' },
                        },
                    },
                    'deploy/testInstance/testBU'
                );
                assert.fail('Expected shared retrieval to fail');
            } catch (ex) {
                assert.include(ex.message, '9999999');
                assert.include(ex.message, 'shared');
                assert.equal(ex.cause, cause);
            }
        });
    }
});
