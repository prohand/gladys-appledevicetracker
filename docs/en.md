# Apple Device Tracker

This integration signs in to your iCloud account, reads the position of the
devices visible in **Find My** and exposes them in Gladys as **presence
sensors**. You can then trigger scenes on "my iPhone arrives home" or "nobody
is here any more".

## What you get

One Gladys device per Apple device (iPhone, iPad, Mac, Apple Watch, AirPods,
AirTag…), with these measurements:

| Measurement        | Type          | What it is for                                  |
| ------------------ | ------------- | ----------------------------------------------- |
| Presence           | Binary        | The scene trigger (1 = at home)                 |
| Distance from home | Decimal (km)  | Follow how far away you are, pre-heat the house |
| Position accuracy  | Integer (m)   | Tell a GPS fix from a Wi-Fi guess               |
| Position           | Text          | "latitude,longitude", handy when debugging      |
| Position age       | Integer (min) | Spot a device that stopped reporting            |
| Battery            | Integer (%)   | Alert on a low battery                          |
| Charging           | Binary        | Know whether the device is plugged in           |

Battery and charging only show up on devices that report them: an AirTag has
neither.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Fill in your **Apple ID** (the email of the iCloud account) and your
   **password**. Gladys stores them encrypted and only sends them to Apple.
3. The **latitude** and **longitude** of your home are pre-filled with the
   position of your Gladys house: leave them alone unless you want another
   reference point. If they stay empty — a house created without an address —
   click **Get the coordinates of my Gladys house** (the action tells you what
   is blocking), or type them in decimal degrees (`48.8566`, `2.3522`, copied
   from any map service). Set the **radius** inside which a device counts as present (150 m
   by default — raise it if you have a large property, or if your devices are
   often located through Wi-Fi).
4. Save.

### Two-factor authentication

If your account uses two-factor authentication — Apple's default — a 6-digit
code appears on your Apple devices right after you save. The integration
**explicitly asks** Apple to send it: an account with no trusted device (only a
phone number) receives it by **SMS**.

1. Note the code. The message shown in the Configuration tab says where it was
   sent (trusted devices, or phone number).
2. In the **Configuration** tab, click **Send the two-factor code**, type it in
   and validate.
3. The integration then asks Apple to **trust** this session, so the code is not
   requested again on the next restarts (Apple keeps that trust for roughly 30
   days, sometimes less).

If nothing arrives, click **Send me a new two-factor code**: Apple sends
another one (push first, SMS as a fallback) without starting over. And when the
notification still does not show up on your devices, **Send me the code by SMS**
forces it to a trusted phone number.

## Advanced settings

- **Refresh interval** (`poll_frequency`, 300 s by default): how often the
  integration asks Apple for a new position. This is the first knob to turn —
  shorter means a more reactive presence, but more calls to Apple and more
  battery used on your devices. The minimum is 60 s. Gladys itself cannot poll
  slower than once a minute: between two real refreshes the integration simply
  answers with the last known position. Whatever the setting, it never calls
  Apple more than once every 30 seconds, and a single call covers all your
  devices.
- **Maximum accuracy** (500 m by default): a position reported with a wider
  uncertainty radius is **ignored**. Without that guard, a position derived
  from a carrier Wi-Fi network would make your presence jump by kilometers.
- **Include family devices**: also expose the devices shared through Family
  Sharing.

### Presence hysteresis

A device becomes present as soon as it enters the radius, but only becomes
absent past **125% of the radius**. With a 150 m radius, it has to go beyond
187 m to count as gone. That is what keeps a phone sitting at the edge of the
zone from firing your scenes over and over because of GPS noise.

## Actions

- **Send the two-factor code** — validates the 6-digit code and gets the
  session trusted by Apple.
- **Send me a new two-factor code** — asks Apple for another code: a push to the
  trusted devices, or an SMS when the account has none.
- **Send me the code by SMS** — forces the code to a trusted phone number, even
  when the account has trusted devices.
- **Get the coordinates of my Gladys house** — fills the latitude and longitude
  from your Gladys house, and shows the exact error when Gladys does not serve
  them. Reload the page to see the filled fields.
- **Test the iCloud connection** — signs in again and shows how many devices
  were found, with their names.
- **Forget the saved session** — deletes the stored tokens. Use it when the
  connection is stuck in an odd state: the next sign-in starts from scratch
  (and will ask for a new two-factor code).
- **Make a device ring** — pick one of your devices and it plays the Find My
  sound. Handy to find a phone in the sofa.

## Troubleshooting

**"iCloud connection failed: ..."**: the message repeats Apple's own answer.
The usual causes are a changed password, an account temporarily locked after
too many attempts, or a session that needs approving again.

**No two-factor code arrives**: use **Send me a new two-factor code**, then
**Send me the code by SMS**. The message shown in the Configuration tab repeats
the reason Apple gave when it refused to send anything. Then
check on appleid.apple.com that the account really has a trusted device or a
trusted phone number — without one of the two, Apple has nowhere to send it.

**The coordinates stay empty**: the integration reads the position of your
house through the Gladys API, which needs the `location` permission (declared
in its manifest) and a house with an address (Settings → House). The **Get the
coordinates of my Gladys house** action shows the exact reason it was refused.

**No device shows up**: check that **Find My iPhone** is enabled on those
devices (Settings → your name → Find My). A device that has been off or offline
for a long time may report no position at all; it appears in Gladys but without
presence until Apple has something recent.

**Presence never moves**: look at the _Position accuracy_ measurement. If it is
close to or above your "Maximum accuracy" setting, positions are being ignored
— raise the threshold, or the home radius.

**The two-factor code is asked for often**: Apple decides how long a session
stays trusted. Avoid changing the password or revoking sessions from
appleid.apple.com.

The integration logs everything it does: read its logs from the Gladys
interface (or `docker logs` on the host), with `LOG_LEVEL=debug` for the full
detail.

## Good to know

Apple publishes **no official API** for Find My. This integration uses the same
interface as the icloud.com website, with the same secure sign-in mechanism
(SRP: your password never leaves your machine, only a cryptographic proof is
sent). Apple can change that interface without notice: if the integration stops
working overnight, that is the most likely cause.

Your credentials stay with you, in your Gladys instance, and never go through
any third-party service.
