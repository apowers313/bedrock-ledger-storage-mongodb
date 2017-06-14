/*
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
/* globals should */
'use strict';

const _ = require('lodash');
const async = require('async');
const bedrock = require('bedrock');
const blsMongodb = require('bedrock-ledger-storage-mongodb');
const config = require('bedrock').config;
const crypto = require('crypto');
const database = require('bedrock-mongodb');
const helpers = require('./helpers');
let jsonld = bedrock.jsonld;
const jsigs = require('jsonld-signatures')();
const mockData = require('./mock.data');
const uuid = require('uuid/v4');
let request = require('request');

// ensure that requests always send JSON
request = request.defaults({json: true});

// FIXME: Do not use an insecure document loader in production
const nodeDocumentLoader = jsonld.documentLoaders.node({
  secure: false,
  strictSSL: false
});
jsonld.documentLoader = (url, callback) => {
  if(url in config.constants.CONTEXTS) {
    return callback(
      null, {
        contextUrl: null,
        document: config.constants.CONTEXTS[url],
        documentUrl: url
      });
  }
  nodeDocumentLoader(url, callback);
};

// use local JSON-LD processor for checking signatures
jsigs.use('jsonld', jsonld);

const exampleLedgerId = 'did:v1:' + uuid.v4();
const configBlockTemplate = {
  id: exampleLedgerId + '/blocks/1',
  ledger: exampleLedgerId,
  type: 'WebLedgerConfigurationBlock',
  consensusMethod: {
    type: 'Continuity2017'
  },
  configurationAuthorizationMethod: {
    type: 'ProofOfSignature2016',
    approvedSigner: [
      'did:v1:53ebca61-5687-4558-b90a-03167e4c2838/keys/144'
    ],
    minimumSignaturesRequired: 1
  },
  writeAuthorizationMethod: {
    type: 'ProofOfSignature2016',
    approvedSigner: [
      'did:v1:53ebca61-5687-4558-b90a-03167e4c2838/keys/144'
    ],
    minimumSignaturesRequired: 1
  },
  signature: {
    type: 'RsaSignature2017',
    created: '2017-10-24T05:33:31Z',
    creator: 'did:v1:53ebca61-5687-4558-b90a-03167e4c2838/keys/144',
    domain: 'example.com',
    signatureValue: 'eyiOiJJ0eXAK...EjXkgFWFO'
  }
};

const eventBlockTemplate = {
  id: '',
  type: 'WebLedgerEventBlock',
  event: [{
    '@context': 'https://w3id.org/webledger/v1',
    id: '',
    type: 'WebLedgerEvent',
    operation: 'Create',
    input: [{
      id: 'https://example.com/events/123456',
      description: 'Example event',
      signature: {
        type: 'RsaSignature2017',
        created: '2017-05-10T19:47:13Z',
        creator: 'http://example.com/keys/123',
        signatureValue: 'gXI7wqa...FMMJoS2Bw=='
      }
    }],
    signature: {
      type: 'RsaSignature2017',
      created: '2017-05-10T19:47:15Z',
      creator: 'http://example.com/keys/789',
      signatureValue: 'JoS27wqa...BFMgXIMw=='
    }
  }],
  previousBlock: '',
  previousBlockHash: '',
  signature: {
    type: 'RsaSignature2017',
    created: '2017-10-24T05:33:31Z',
    creator: 'did:v1:53ebca61-5687-4558-b90a-03167e4c2838/keys/144',
    domain: 'example.com',
    signatureValue: 'eyiOiJJ0eXAK...WFOEjXkgF'
  }
};

// test hashing function
function testHasher(data, callback) {
  // ensure a basic context exists
  if(!data['@context']) {
    data['@context'] = 'https://w3id.org/webledger/v1';
  }

  jsonld.normalize(data, {
    algorithm: 'URDNA2015',
    format: 'application/nquads'
  }, function(err, normalized) {
    const hash = crypto.createHash('sha256').update(normalized).digest();
    callback(err, hash);
  });
}

describe('Block Storage API', () => {
  let ledgerStorage;

  before(done => {
    const configBlock = _.cloneDeep(configBlockTemplate);
    const meta = {};
    const options = {
      eventHasher: testHasher,
      blockHasher: testHasher
    };

    blsMongodb.create(configBlock, meta, options, (err, storage) => {
      ledgerStorage = storage;
      done(err);
    });
  });
  beforeEach(done => {
    // FIXME: Remove ledger
    done();
  });
  it('should create block', done => {
    const eventBlock = _.cloneDeep(eventBlockTemplate);
    eventBlock.id = exampleLedgerId + '/blocks/2';
    eventBlock.event[0].id = exampleLedgerId + '/events/1';
    const meta = {
      pending: true
    };
    const options = {};

    // create the block
    ledgerStorage.blocks.create(eventBlock, meta, options, (err, result) => {
      should.not.exist(err);
      should.exist(result);
      should.exist(result.block);
      should.exist(result.meta);

      // ensure the block was created in the database
      const query = {id: database.hash(eventBlock.id)};
      ledgerStorage.blocks.collection.findOne(query, (err, record) => {
        should.not.exist(err);
        should.exist(record);
        should.exist(record.id);
        should.exist(record.block.id);
        should.exist(record.meta.pending);
        done();
      });
    });
  });
  it('should not create duplicate block', done => {
    const eventBlock = _.cloneDeep(eventBlockTemplate);
    eventBlock.id = exampleLedgerId + '/blocks/2';
    eventBlock.event[0].id = exampleLedgerId + '/events/1';
    const meta = {
      pending: true
    };
    const options = {};

    // create the block
    ledgerStorage.blocks.create(eventBlock, meta, options, (err, result) => {
      should.exist(err);
      err.name.should.equal('DuplicateBlockId');
      done();
    });
  });
  it('should get block', done => {
    const blockId = exampleLedgerId + '/blocks/2';
    const options = {};

    // get an existing block
    ledgerStorage.blocks.get(blockId, options, (err, iterator) => {
      should.not.exist(err);
      should.exist(iterator);

      let blockCount = 0;
      async.eachSeries(iterator, (promise, callback) => {
        promise.then(result => {
          should.exist(result.block);
          should.exist(result.meta);
          result.block.id.should.equal(exampleLedgerId + '/blocks/2');
          blockCount++;
          callback();
        }, callback);
      }, err => {
        blockCount.should.equal(1);
        done(err);
      });
    });
  });
  it('should fail to get non-existent block', done => {
    const blockId = exampleLedgerId + '/blocks/INVALID';
    const options = {};

    // attempt to get non-existent block
    let blockCount = 0;
    ledgerStorage.blocks.get(blockId, options, (err, iterator) => {
      async.eachSeries(iterator, (promise, callback) => {
        promise.then(result => {
          should.not.exist(result);
          blockCount++;
          callback();
        }, callback);
      }, err => {
        should.not.exist(err);
        blockCount.should.equal(0);
        done(err);
      });
    });
  });
  it.skip('should get latest blocks', done => {
    done();
  });
  it.skip('should update block', done => {
    done();
  });
  it('should delete block', done => {
    const eventBlock = _.cloneDeep(eventBlockTemplate);
    eventBlock.id = exampleLedgerId + '/blocks/3';
    eventBlock.event[0].id = exampleLedgerId + '/events/2';
    const meta = {
      pending: true
    };
    const options = {};

    // create the block
    ledgerStorage.blocks.create(eventBlock, meta, options, (err, result) => {
      should.not.exist(err);

      // delete the block
      ledgerStorage.blocks.delete(eventBlock.id, options, (err) => {
        should.not.exist(err);
        done();
      });
    });
  });
  it('should fail to delete non-existent block', done => {
    const eventBlockId = exampleLedgerId + '/blocks/INVALID';
    const options = {};

    // delete the block
    ledgerStorage.blocks.delete(eventBlockId, options, (err) => {
      should.exist(err);
      err.name.should.equal('BlockDoesNotExist');
      done();
    });
  });
});
