import StorageService from './StorageService'
import getRandomValues from 'get-random-values'
import createHash from 'create-hash'
import { findTargetPort, trySocket } from './utils'
import { events, nonFunc } from './constants'

export * from './constants'

const sha256 = data =>
  createHash('sha256')
    .update(data)
    .digest('hex')

const random = () => {
  const array = new Uint8Array(24)
  getRandomValues(array)
  return array.join('')
}

export default class SocketService {
  constructor(name) {
    this.plugin = name

    this.socket = null
    this.connected = false
    this.paired = false
    this.openRequests = []
    this.pairingPromise = null
    this.eventHandlers = {}

    this.appkey = StorageService.getAppKey()
    if (!this.appkey) this.appkey = 'appkey:' + random()
  }

  addEventHandler(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [handler]
    } else {
      this.eventHandlers[event].push(handler)
    }
  }

  removeEventHandler(event) {
    if (!event) {
      return
    }

    delete this.eventHandlers[event]
  }

  onMsgPaired(result) {
    this.paired = result

    if (this.paired) {
      const savedKey = StorageService.getAppKey()
      const hashed =
        this.appkey.indexOf('appkey:') > -1 ? sha256(this.appkey) : this.appkey

      if (!savedKey || savedKey !== hashed) {
        StorageService.setAppKey(hashed)
        this.appkey = StorageService.getAppKey()
      }
    }

    this.pairingPromise.resolve(result)
  }

  onMsgRekey() {
    this.appkey = 'appkey:' + random()
    this.send('rekeyed', {
      data: { appkey: this.appkey, origin: this.getOrigin() },
      plugin: this.plugin
    })
  }

  onMsgApi(response) {
    if (typeof response === 'string') {
      try {
        response = JSON.parse(response)
      } catch (e) {
        console.error('Error parsing json for response: ', response)
      }
    }

    const openRequest = this.openRequests.find(
      x => x.payload.id === response.id
    )
    if (!openRequest) return

    this.openRequests = this.openRequests.filter(
      x => x.payload.id !== response.id
    )

    const isErrorResponse =
      response.error !== null && response.error !== undefined

    if (isErrorResponse) {
      openRequest.reject(response.error)
    } else {
      openRequest.resolve(response.result)
    }
  }

  onMsgEvent({ event, payload }) {
    if (!this.eventHandlers[event]) {
      return
    }

    const handlers = this.eventHandlers[event]
    for (let handler of handlers) {
      handler(payload)
    }
  }

  socketMsgHandler(msg) {
    // Handshaking/Upgrading
    if (msg.data.indexOf('42/chainx') === -1) return false

    // Real message
    const [type, data] = JSON.parse(msg.data.replace('42/chainx,', ''))

    if (type === 'pong') return
    if (type === 'ping') return this.socket.send(`42/chainx,["pong"]`)

    switch (type) {
      case 'paired':
        return this.onMsgPaired(data)
      case 'rekey':
        return this.onMsgRekey()
      case 'api':
        return this.onMsgApi(data)
      case 'event':
        return this.onMsgEvent(data)
      case 'connected':
        console.log('Receive ChainX signer connected message')
        return
      default:
        console.log(`Unknown type message ${type}`)
    }
  }

  link() {
    return new Promise(async (resolve, reject) => {
      const targetPort = await findTargetPort()
      if (!targetPort) {
        return reject()
      }

      const s = await trySocket(targetPort)
      if (s) {
        this.socket = s
        this.send()
        this.connected = true
        this.socket.onmessage = this.socketMsgHandler.bind(this)
        this.socket.onclose = nonFunc
        this.pairingPromise = null
        this.pair(true).then(() => resolve(true))
      } else {
        resolve(false)
      }
    })
  }

  addSocketCloseHandler(handler = nonFunc) {
    if (this.socket) {
      this.socket.onclose = handler
    }
  }

  isConnected() {
    return this.connected
  }

  isPaired() {
    return this.paired
  }

  disconnect() {
    this.manualDisconnet = true
    if (this.socket) {
      this.socket.close()
      this.connected = false
    }
    return true
  }

  sendApiRequest(payload = {}, callback = null) {
    const normalizedPayload = {
      ...payload,
      id: random()
    }

    return new Promise(async (resolve, reject) => {
      await this.pair()
      if (!this.paired) {
        return reject({
          code: 'not_paired',
          message: 'The user did not allow this app to connect to their chainx'
        })
      }

      const data = {
        appkey: this.appkey, // Set Application Key
        payload: normalizedPayload,
        origin: this.getOrigin()
      }
      this.openRequests.push(Object.assign(data, { resolve, reject }))

      if (
        [
          'chainx_sign_send',
          'chainx_sign',
          'chainx2_sign_send',
          'chainx2_sign'
        ].includes(data.payload.method) &&
        typeof callback === 'function'
      ) {
        this.addEventHandler(events.TX_STATUS, ({ id, err, status }) => {
          if (data.payload.id !== id) {
            return
          }

          callback(err, status)

          if (err || (status && status.status === 'Finalized')) {
            this.removeEventHandler(events.TX_STATUS)
          }
        })
      }

      try {
        this.send('api', { data, plugin: this.plugin })
      } catch (e) {
        reject({
          code: 'network_error',
          message: 'can not send api request'
        })
      }
    })
  }

  pair(passthrough = false) {
    return new Promise((resolve, reject) => {
      this.pairingPromise = { resolve, reject }
      this.send('pair', {
        data: { appkey: this.appkey, origin: this.getOrigin(), passthrough },
        plugin: this.plugin
      })
    })
  }

  send(type = null, data = null) {
    if (type === null && data === null) {
      this.socket.send('40/chainx')
    } else {
      this.socket.send('42/chainx,' + JSON.stringify([type, data]))
    }
  }

  getOrigin() {
    return SocketService.getOriginOrPlugin(this.plugin)
  }

  static getOriginOrPlugin(plugin) {
    let origin
    if (typeof window.location !== 'undefined') {
      if (
        window.location.hasOwnProperty('hostname') &&
        window.location.hostname.length &&
        window.location.hostname !== 'localhost'
      ) {
        origin = window.location.hostname
      } else {
        origin = plugin
      }
    } else {
      origin = plugin
    }
    if (origin.substr(0, 4) === 'www.') {
      origin = origin.replace('www.', '')
    }
    return origin
  }

  async getCurrentAccount() {
    return await this.sendApiRequest({
      method: 'chainx_account',
      params: []
    })
  }

  async getCurrentNode() {
    return await this.sendApiRequest({
      method: 'chainx_get_node',
      params: []
    })
  }

  async getSettings() {
    return await this.sendApiRequest({
      method: 'get_settings',
      params: []
    })
  }

  async signAndSendExtrinsic(address, hex, callback = nonFunc) {
    return await this.sendApiRequest(
      {
        method: 'chainx_sign_send',
        params: [address, hex]
      },
      callback
    )
  }

  async signExtrinsic(address, hex) {
    return await this.sendApiRequest({
      method: 'chainx_sign',
      params: [address, hex]
    })
  }

  async signAndSendChainx2Extrinsic(address, data, callback = nonFunc) {
    return await this.sendApiRequest(
      {
        method: 'chainx2_sign_send',
        params: [address, data]
      },
      callback
    )
  }

  async signChainx2Extrinsic(address, data) {
    return await this.sendApiRequest({
      method: 'chainx2_sign',
      params: [address, data]
    })
  }

  listenAccountChange(listener = nonFunc) {
    this.addEventHandler(events.ACCOUNT_CHANGE, listener)
  }

  removeAccountChangeListener(listener) {
    this.removeEventHandler(events.ACCOUNT_CHANGE, listener)
  }

  listenNodeChange(listener = nonFunc) {
    this.addEventHandler(events.NODE_CHANGE, listener)
  }

  removeNodeChangeListener(listener) {
    this.removeEventHandler(events.NODE_CHANGE, listener)
  }

  listenNetworkChange(listener = nonFunc) {
    this.addEventHandler(events.NETWORK_CHANGE, listener)
  }

  removeNetworkChangeListener(listener) {
    this.removeEventHandler(events.NETWORK_CHANGE, listener)
  }

  removeEventListener(event, listener) {
    const handlers = this.eventHandlers[event]
    const index = handlers.findIndex(h => h === listener)
    if (index >= 0) {
      handlers.splice(index, 1)
    }
  }
}
