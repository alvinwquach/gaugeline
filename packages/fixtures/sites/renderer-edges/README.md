# renderer-edges

An invented bakery (Quillfeather Bakery) whose pages each try one thing a rendered page must not be allowed to do, for the renderer's integration and end-to-end tests (render-01). Nothing here is a real business, and no page here sends anything anywhere: the tests assert that nothing it tries leaves.

| Path                | What the page does                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`                 | A normal page: a menu of links, an image, a script that fills in a line after load, an analytics tag        |
| `/post-form.html`   | Submits a POST form on load, and posts from a script                                                        |
| `/get-form.html`    | Submits a GET form on load                                                                                  |
| `/beacon.html`      | Sends analytics beacons: to an analytics host, to its own server by `sendBeacon`, and an image pixel        |
| `/popup.html`       | Opens two windows                                                                                           |
| `/socket.html`      | Opens a WebSocket to its own host and to another                                                            |
| `/to-private`       | Redirects to a cloud metadata address                                                                       |
| `/to-other-port`    | Redirects to another port on the loopback address                                                           |
| `/ok-redirect`      | Redirects to `/about.html`, once                                                                            |
| `/loop`             | Redirects to itself, for ever                                                                               |
| `/huge`             | Answers three million bytes                                                                                 |
| `/many.html`        | Asks for four hundred images                                                                                |
| `/webrtc.html?port=N` | Opens WebRTC peer connections (STUN and TURN to loopback UDP port N), a WebTransport and a media request |
| `/state.html`       | Reads its cookies and storage into its title, then sets them, to show each render starts with none          |
| `/private-sub.html` | Asks for an image on a private address and a frame on a metadata address                                    |

The addresses `169.254.169.254` and `10.0.0.5` are the reserved metadata and private ranges, used as text only: the tests assert nothing ever connects to them.
