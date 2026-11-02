#!/usr/bin/env python3
"""Regenerate Telegram-iOS 'fake-codesigning' profiles for HBOLT.

The upstream fake profiles expire (Bazel refuses expired ones). This rewrites each
profile with a 10-year expiry and the HBOLT bundle id, then re-wraps it as CMS.
Real signing happens later on the phone (KSign / ESign / Sideloadly).
Usage: make-profiles.py <fake-codesigning-dir> <new-bundle-id>
"""
import datetime, os, plistlib, subprocess, sys, tempfile

src, new_id = sys.argv[1], sys.argv[2]
OLD = "ph.telegra.Telegraph"
prof_dir, p12 = os.path.join(src, "profiles"), os.path.join(src, "certs", "SelfSigned.p12")
tmp = tempfile.mkdtemp()
key, crt = os.path.join(tmp, "k.pem"), os.path.join(tmp, "c.pem")
for extra in (["-legacy"], []):
    r = subprocess.run(["openssl", "pkcs12", "-in", p12, "-nodes", "-passin", "pass:", "-out", key, *extra], capture_output=True)
    if r.returncode == 0: break
else: sys.exit("cannot read SelfSigned.p12: " + r.stderr.decode())
subprocess.run(["openssl", "x509", "-in", key, "-out", crt], check=True)

def swap(v):
    if isinstance(v, str): return v.replace(OLD, new_id)
    if isinstance(v, list): return [swap(x) for x in v]
    if isinstance(v, dict): return {k: swap(x) for k, x in v.items()}
    return v

now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)
for name in sorted(os.listdir(prof_dir)):
    if not name.endswith(".mobileprovision"): continue
    path = os.path.join(prof_dir, name)
    raw = subprocess.run(["openssl", "smime", "-inform", "der", "-verify", "-noverify", "-in", path], capture_output=True, check=True).stdout
    d = plistlib.loads(raw)
    d.pop("DER-Encoded-Profile", None)
    certs = d.get("DeveloperCertificates")
    d = swap(d)
    d["DeveloperCertificates"] = certs
    d["CreationDate"], d["ExpirationDate"], d["TimeToLive"] = now, now + datetime.timedelta(days=3650), 3650
    plain = os.path.join(tmp, name + ".plist")
    with open(plain, "wb") as f: plistlib.dump(d, f)
    subprocess.run(["openssl", "cms", "-sign", "-binary", "-nodetach", "-outform", "der", "-signer", crt, "-inkey", key,
                    "-in", plain, "-out", path], check=True)
    print(f"{name}: {d['Entitlements'].get('application-identifier')} until {d['ExpirationDate']:%Y-%m-%d}")
