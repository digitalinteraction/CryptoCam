# CryptoCam: Camera

## Requirements

1. Node 7.x <
2. `libavconv`
3. AWS credentials in `.aws/credentials`

## Installation

1. Clone repo onto Raspberry Pi with camera (ensure camera enabled in `sudo raspi-config`).
2. Run `npm install` (`libusb` will fail to build on Linux, this is expected).
3. Run CryptoCam without logging with `./run` (root required if node not given bluetooth permissions with `sudo setcap cap_net_raw+eip $(eval readlink -f ``which node``)`).

    -- Run with `node --harmony-async-await app --debug` to get full output (flag `--harmony-async-await` not required on 8.x <).
