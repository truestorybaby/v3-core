const Web3 = require('web3')
const { exec } = require('child_process')
const { BN, expectRevert, expectEvent, time, balance } = require('@openzeppelin/test-helpers')
const { createRLPHeader, calculateBlockHash, addToHex } = require('../utils/utils')
// const expectEvent = require('./expectEvent');
const RLP = require('rlp')
const { bufArrToArr, arrToBufArr, toBuffer } = require('ethereumjs-util')

const { INFURA_ENDPOINT } = require('../constants')
const LOCAL_ENDPOINT = 'http://127.0.0.1:7545'
const Ethrelay = artifacts.require('./EthrelayTestContract')
const Ethash = artifacts.require('./Ethash')
const VerifyTransaction = artifacts.require('./VerifyTransaction')
const Token = artifacts.require('./BaddToken')
const Factory = artifacts.require('./UniswapV3Factory')
const Pool = artifacts.require('./UniswapV3Pool')
const { expect } = require('chai')
const { web3 } = require('@openzeppelin/test-helpers/src/setup')

const EPOCH = 1
let GENESIS_BLOCK = 30000

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const LOCK_PERIOD = time.duration.minutes(5)
const ALLOWED_FUTURE_BLOCK_TIME = time.duration.seconds(15)
const MAX_GAS_LIMIT = 2n ** 63n - 1n
const MIN_GAS_LIMIT = 5000
const GAS_LIMIT_BOUND_DIVISOR = 1024n
const GAS_PRICE_IN_WEI = new BN(137140710)

contract('UndoTransfer Test', async (accounts) => {
  let ethrelay
  let ethash
  let verifyTx
  let tokenA
  let tokenB
  let factory
  let pool
  let sourceWeb3
  let alice = accounts[1]
  let bob = accounts[2]

  before(async () => {
    // sourceWeb3 = new Web3(INFURA_ENDPOINT);
    sourceWeb3 = new Web3(LOCAL_ENDPOINT)

    const curBlock = await sourceWeb3.eth.getBlock('latest')
    if (curBlock.number < GENESIS_BLOCK) {
      for (i = curBlock.number; i <= GENESIS_BLOCK; i += 1000) {
        await time.advanceBlockTo(i + 1000)
        console.log('advanced to block ' + (await sourceWeb3.eth.getBlock('latest')).number)
      }
    }

    ethash = await Ethash.new()
    const epochData = require('./epoch-1.json')

    console.log(`Submitting data for epoch ${EPOCH} to Ethash contract...`)
    await submitEpochData(
      ethash,
      EPOCH,
      epochData.FullSizeIn128Resolution,
      epochData.BranchDepth,
      epochData.MerkleNodes
    )
    console.log('Submitted epoch data.')

    // Advance to the next block to correctly read time in the solidity "now" function interpreted by ganache
    await time.advanceBlock()
  })

  beforeEach(async () => {
    GENESIS_BLOCK = (await sourceWeb3.eth.getBlock('latest')).number
    expect(Math.floor(GENESIS_BLOCK / 30000), 'genesis block not in epoch').to.equal(EPOCH)

    const genesisBlock = await sourceWeb3.eth.getBlock(GENESIS_BLOCK)
    const genesisRlpHeader = createRLPHeader(genesisBlock)
    ethrelay = await Ethrelay.new(genesisRlpHeader, genesisBlock.totalDifficulty, ethash.address, {
      from: accounts[0],
      gasPrice: GAS_PRICE_IN_WEI,
    })

    verifyTx = await VerifyTransaction.new(ethrelay.address)

    tokenA = await Token.new('TKA', 100)
    tokenB = await Token.new('TKB', 100)

    factory = await Factory.new()
    pool = await Pool.at((await factory.createPool(tokenA.address, tokenB.address, 500)).logs[0].args.pool)
    await pool.set_verifier(verifyTx.address);
    await tokenA.transfer(alice, 10)
    await tokenA.transfer(bob, 10)
    await tokenA.transfer(pool.address, 30)
    await tokenB.transfer(pool.address, 50)
  })

  describe('Undo_transfer', function () {
    it('should successfully undo_transfer', async () => {
      console.log('Before transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('Before transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      const amountX = 5
      let receipt = await tokenA.transfer(pool.address, amountX, {
        from: alice,
      })
      let tx = await sourceWeb3.eth.getTransaction(receipt.tx)
      const fileName = './tx_' + tx.hash + '.json'
      await submitHeaders(tx, fileName)

      const { Value, Path, Nodes } = require(fileName)
      let txRes = await verifyTx.submitTx(tx.hash, Value, Path, Nodes)
      expectEvent(txRes, 'SubmittedTx', { txHash: tx.hash })

      await verifyTx.submitTxMetaData(tx.hash, tx.from, tx.to, tx.input)
      const res = await verifyTx.getTxMetaData(tx.hash)

      expect(res[0]).to.equal(tx.from)
      expect(res[1]).to.equal(tx.to)
      expect(res[2]).to.equal(tx.input)

      const verificationFee = await verifyTx.getRequiredVerificationFee()
      console.log('After transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('After transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      let balance = (await tokenA.balanceOf(alice)).toNumber()
      expect(
        (
          await pool.undo_transfer(amountX, tx.hash, tx.blockNumber, {
            from: alice,
            value: verificationFee,
          })
        ).receipt.status
      ).to.be.true
      console.log('alice call undo_transfer with ' + amountX + ' amount and correct tx data')
      console.log('After undo_transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('After undo_transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      let balance1 = (await tokenA.balanceOf(alice)).toNumber()
      expect((await tokenA.balanceOf(alice)).toNumber()).to.equal(balance + amountX)
      await removeFile(fileName)
    })

    it('should not successfully undo_transfer when reapting tx', async () => {
      console.log('Before transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('Before transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      const amountX = 5
      let receipt = await tokenA.transfer(pool.address, amountX, {
        from: alice,
      })
      let tx = await sourceWeb3.eth.getTransaction(receipt.tx)
      const fileName = './tx_' + tx.hash + '.json'
      await submitHeaders(tx, fileName)

      const { Value, Path, Nodes } = require(fileName)
      let txRes = await verifyTx.submitTx(tx.hash, Value, Path, Nodes)
      expectEvent(txRes, 'SubmittedTx', { txHash: tx.hash })

      await verifyTx.submitTxMetaData(tx.hash, tx.from, tx.to, tx.input)
      const res = await verifyTx.getTxMetaData(tx.hash)

      expect(res[0]).to.equal(tx.from)
      expect(res[1]).to.equal(tx.to)
      expect(res[2]).to.equal(tx.input)

      const verificationFee = await verifyTx.getRequiredVerificationFee()
      console.log('After transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('After transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      let balance = (await tokenA.balanceOf(alice)).toNumber()
      expect(
        (
          await pool.undo_transfer(amountX, tx.hash, tx.blockNumber, {
            from: alice,
            value: verificationFee,
          })
        ).receipt.status
      ).to.be.true
      console.log('alice call undo_transfer with ' + amountX + ' amount and correct tx data')
      console.log('After undo_transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('After undo_transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      expect((await tokenA.balanceOf(alice)).toNumber()).to.equal(balance + amountX)

      balance += amountX
      await expectRevert.unspecified(
        pool.undo_transfer(amountX, tx.hash, tx.blockNumber, {
          from: alice,
          value: verificationFee,
        })
      )
      console.log('alice call undo_transfer with ' + amountX + ' amount and correct tx data')
      console.log('After undo_transfer: alice token A balance = ' + (await tokenA.balanceOf(alice)).toNumber())
      console.log('After undo_transfer: alice token B balance = ' + (await tokenB.balanceOf(alice)).toNumber())
      expect((await tokenA.balanceOf(alice)).toNumber()).to.equal(balance)
      await removeFile(fileName)
    })
  })

  const submitEpochData = async (ethashContractInstance, epoch, fullSizeIn128Resolution, branchDepth, merkleNodes) => {
    let start = new BN(0)
    let nodes = []
    let mnlen = 0
    let index = 0
    for (let mn of merkleNodes) {
      nodes.push(mn)
      if (nodes.length === 40 || index === merkleNodes.length - 1) {
        mnlen = new BN(nodes.length)

        if (index < 440 && epoch === 128) {
          start = start.add(mnlen)
          nodes = []
          return
        }

        await ethashContractInstance.setEpochData(epoch, fullSizeIn128Resolution, branchDepth, nodes, start, mnlen)

        start = start.add(mnlen)
        nodes = []
      }
      index++
    }
  }

  const submitHeaders = async (tx, fileName) => {
    await generateTxHeader(tx.hash, fileName)

    const requiredStakePerBlock = await verifyTx.getRequiredStakePerBlock()
    await verifyTx.deposit({
      value: requiredStakePerBlock.mul(new BN(tx.blockNumber + 7 - (GENESIS_BLOCK + 1))),
    })
    let lockedUntil = 0
    for (let i = GENESIS_BLOCK + 1; i < tx.blockNumber + 7; i++) {
      if (await verifyTx.isHeaderStored(i)) {
        continue
      }
      const rlpHeader = createRLPHeader(await sourceWeb3.eth.getBlock(i))
      // console.log("submitting block " + i);
      await time.increase(time.duration.seconds(15))
      const res = await verifyTx.submitBlock(i, rlpHeader)
      expectEvent(res, 'SubmittedBlock', {
        blockNumber: new BN(i),
      })
      const submitTime = await time.latest()
      lockedUntil = submitTime.add(LOCK_PERIOD)
    }
    await time.increaseTo(lockedUntil)
    await time.increase(time.duration.seconds(1))
  }

  const generateTxHeader = async (txHash, fileName) => {
    exec('go run ./cmd/go-ethrelay verify transaction ' + txHash + ' --json', (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`)
        return
      }
      if (stderr) {
        console.log(`stderr: ${stderr}`)
        return
      }
      console.log(`stdout: ${stdout}`)
    })
    await sleep(5000)
    exec('mv ./tx_' + txHash + ' ' + fileName, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`)
        return
      }
      if (stderr) {
        console.log(`stderr: ${stderr}`)
        return
      }
      console.log(`stdout: ${stdout}`)
    })
  }

  const removeFile = async (fileName) => {
    exec('rm ' + fileName, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`)
        return
      }
      if (stderr) {
        console.log(`stderr: ${stderr}`)
        return
      }
      console.log(`stdout: ${stdout}`)
    })
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
})
