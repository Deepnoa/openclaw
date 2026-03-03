import Testing
@testable import OpenClawDiscovery

@Suite
struct TailscaleServeGatewayDiscoveryTests {
    @Test func discoversServeGatewayFromTailnetPeers() async {
        let statusJson = """
        {
          "Self": {
            "DNSName": "my-mac.tail06a72.ts.net.",
            "HostName": "my-mac",
            "Online": true
          },
          "Peer": {
            "peer-1": {
              "DNSName": "gutsy-home.tail06a72.ts.net.",
              "HostName": "gutsy-home",
              "Online": true
            },
            "peer-2": {
              "DNSName": "OFFLINE.tail06a72.ts.net.",
              "HostName": "offline-box",
              "Online": false
            },
            "peer-3": {
              "DNSName": "my-mac.tail06a72.ts.net.",
              "HostName": "my-mac",
              "Online": true
            }
          }
        }
        """

        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            probeHost: { host, _ in
                host == "gutsy-home.tail06a72.ts.net"
            })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.0, context: context)
        #expect(beacons.count == 1)
        #expect(beacons.first?.displayName == "gutsy-home")
        #expect(beacons.first?.tailnetDns == "gutsy-home.tail06a72.ts.net")
        #expect(beacons.first?.host == "gutsy-home.tail06a72.ts.net")
        #expect(beacons.first?.port == 443)
    }

    @Test func returnsEmptyWhenStatusUnavailable() async {
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { nil },
            probeHost: { _, _ in true })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.0, context: context)
        #expect(beacons.isEmpty)
    }
}
