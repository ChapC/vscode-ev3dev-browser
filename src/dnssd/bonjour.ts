
import * as bonjour from 'bonjour';
import * as events from 'events';
import * as os from 'os';

import * as dnssd from '../dnssd';

export function getInstance(): dnssd.Client {
    return new BonjourClient();
}

class BonjourClient extends events.EventEmitter implements dnssd.Client {
    private readonly bClients: { [ifaceAddress: string]: bonjour.Bonjour } = {};
    private readonly ifaceAddresses = new Array<string>();
    private readonly ifaceTimer = setInterval(() => this.updateInterfaces(), 500);

    forEachClient(func: (bClient: bonjour.Bonjour) => void) {
        for (const a in this.bClients) {
            func(this.bClients[a]);
        }
    }

    public browse(opts: dnssd.BrowseOptions): Promise<dnssd.Browser> {
        const browser = new BonjourBrowser(this, opts);
        return Promise.resolve(browser);
    }

    public destroy(): void {
        clearInterval(this.ifaceTimer);
        for (const a in this.bClients) {
            this.destroyClient(a);
        }
        this.removeAllListeners();
    }

    // The bonjour package doesn't seem to be able to handle broadcasting and
    // receiving on all interfaces. So, we are monitoring network interfaces
    // ourselves and creating a bonjour.Bonjour instance for each network
    // interface (actually, each address of each interface, which could be
    // more than one).
    private updateInterfaces() {
        const newAddresses = new Array<string>();
        const ifaces = os.networkInterfaces();
        for (let i in ifaces) {
            // only supporting IPv4 for now
            const addresses = ifaces[i].filter(v => v.family == 'IPv4').map(v => v.address);
            newAddresses.push(...addresses);
        }
        const added = newAddresses.filter(a => this.ifaceAddresses.indexOf(a) == -1);
        const removed = this.ifaceAddresses.filter(a => newAddresses.indexOf(a) == -1);
        if (added.length) {
            for (const a of added) {
                this.ifaceAddresses.push(a);
                this.createClient(a);
            }
        }
        if (removed.length) {
            const indexes = removed.map(a => this.ifaceAddresses.indexOf(a));
            indexes.forEach(i => {
                const [a] = this.ifaceAddresses.splice(i, 1);
                this.destroyClient(a);
            }, this);
        }
    }

    /**
     * Asyncronusly create an new bonjour.Bonjour client object
     * @param ifaceAddress the IP address
     */
    private createClient(ifaceAddress: string): void {
        // work around bonjour issue where error is not handled
        new Promise<bonjour.Bonjour>((resolve, reject) => {
            const bClient = bonjour({interface: ifaceAddress});
            (<any> bClient)._server.mdns.on('ready', () => resolve(bClient));
            (<any> bClient)._server.mdns.on('error', err => reject(err));
        }).then(bClient => {
            if (this.ifaceAddresses.indexOf(ifaceAddress) < 0) {
                // iface was removed while we were waiting for promise
                bClient.destroy();
                return;
            }
            this.bClients[ifaceAddress] = bClient;
            this.emit('clientAdded', bClient);
        }).catch(err => {
            if (err.code == 'EADDRNOTAVAIL') {
                // when a new network interface first comes up, we can get this
                // error when we try to bind to the socket, so keep trying until
                // we are bound or the interface goes away.
                setTimeout(() => {
                    if (this.ifaceAddresses.indexOf(ifaceAddress) >= 0) {
                        this.createClient(ifaceAddress);
                    }
                }, 500);
            }
            // FIXME: other errors are currently ignored
        });
    }

    /**
     * Destroys the bonjour.Bonjour client associated with ifaceAddress
     * @param ifaceAddress the IP address
     */
    private destroyClient(ifaceAddress: string): void {
        const bClient = this.bClients[ifaceAddress];
        delete this.bClients[ifaceAddress];
        this.emit('clientRemoved', bClient);
        bClient.destroy();
    }
}

class BonjourBrowser extends events.EventEmitter implements dnssd.Browser {
    private readonly browsers = new Array<{
        bClient: bonjour.Bonjour,
        browser: bonjour.Browser,
        services: BonjourService[]
    }>();

    constructor(private readonly client: BonjourClient, private readonly opts: dnssd.BrowseOptions) {
        super();
        client.on('clientAdded', c => this.addBrowser(c));
        client.on('clientRemoved', c => this.removeBrowser(c));
        client.forEachClient(c => this.addBrowser(c));
    }

    public destroy(): void {
        for (const b of this.browsers) {
            b.browser.stop();
        }
    }

    private addBrowser(bClient: bonjour.Bonjour) {
        const browser = bClient.find({
            type: this.opts.service,
            protocol: this.opts.transport,
        });
        const services = new Array<BonjourService>();
        browser.on('up', s => {
           const service =  new BonjourService(s);
           services.push(service);
           this.emit('added', service);
        });
        browser.on('down', s => {
            const index = services.findIndex(v => v.bService == s);
            const [service] = services.splice(index, 1);
            this.emit('removed', service);
        });
        this.browsers.push({bClient: bClient, browser: browser, services: services});
        browser.start();
    }

    private removeBrowser (bClient: bonjour.Bonjour): void {
        const i = this.browsers.findIndex(v => v.bClient == bClient);
        const [removed] = this.browsers.splice(i, 1);
        removed.browser.stop();
        for (const s of removed.services) {
            this.emit('removed', s);
        }
    }
}

class BonjourService implements dnssd.Service {
    public readonly name: string;
    public readonly service: string;
    public readonly transport: 'tcp' | 'udp';
    public readonly host: string;
    public readonly domain: string;
    public readonly ipv: 'IPv4' | 'IPv6';
    public readonly address: string;
    public readonly port: number;
    public readonly txt: dnssd.TxtRecords;

    constructor(public readonly bService: bonjour.Service) {
        this.name = bService.name;
        this.service = bService.type;
        this.transport = <'tcp' | 'udp'> bService.protocol;
        this.host = bService.host;
        this.domain = (<any> bService).domain;
        this.address = (<any> bService).addresses[0]; // FIXME
        this.port = bService.port;
        this.txt = <dnssd.TxtRecords> bService.txt;
    }
}
