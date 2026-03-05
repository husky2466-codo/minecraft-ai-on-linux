#!/usr/bin/env python3
"""
Quickfix for current arena:
  1. Clear the floating stone/dirt/ore platform at Y=44-80 (came from hardcoded Y values in build)
  2. Teleport Sage into the arena
  3. Spawn 16 more trees (denser coverage)
"""
import socket, struct, time, math

RCON_HOST = '127.0.0.1'
RCON_PORT = 25575
RCON_PASS = 'ailab743915'
CX, CZ = 0, 0
SY = -60   # flat world surface

class RCON:
    def __init__(self, host, port, password):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect((host, port))
        self._req = 1
        self._send(3, password)
        resp = self._recv()
        if struct.unpack('<i', resp[4:8])[0] == -1:
            raise Exception('RCON auth failed')
        print('  RCON authenticated.')

    def _send(self, ptype, body):
        data = body.encode('utf-8') + b'\x00\x00'
        packet = struct.pack('<III', 4 + 4 + len(data), self._req, ptype) + data
        self.sock.sendall(packet)

    def _recv(self):
        raw = b''
        while len(raw) < 4:
            chunk = self.sock.recv(4096)
            if not chunk: break
            raw += chunk
        length = struct.unpack('<I', raw[:4])[0]
        while len(raw) < 4 + length:
            raw += self.sock.recv(4096)
        body = raw[12:4 + length - 2]
        return raw

    def cmd(self, command):
        self._send(2, command)
        resp = self._recv()
        body = resp[12:-2].decode('utf-8', errors='replace').strip()
        return body

    def fill(self, x1, y1, z1, x2, y2, z2, block):
        r = self.cmd(f'/fill {x1} {y1} {z1} {x2} {y2} {z2} {block}')
        time.sleep(0.08)
        return r

    def setblock(self, x, y, z, block):
        return self.cmd(f'/setblock {x} {y} {z} {block}')

    def close(self):
        self.sock.close()


def clear_floating_layer(r):
    """Remove the platform at Y=44-80 left by the old build (hardcoded Y values)."""
    print('\n[1/3] Clearing floating layer (Y=44 to Y=80)...')
    # Split into 32x32 XZ chunks, 32-block Y bands to stay under fill limit
    y_bands = [(44, 75), (76, 80)]
    x_bands = [(-60, -29), (-28, 3), (4, 35), (36, 60)]
    z_bands = [(-60, -29), (-28, 3), (4, 35), (36, 60)]
    total = len(y_bands) * len(x_bands) * len(z_bands)
    n = 0
    for y1, y2 in y_bands:
        for x1, x2 in x_bands:
            for z1, z2 in z_bands:
                r.fill(x1, y1, z1, x2, y2, z2, 'minecraft:air')
                n += 1
                bar = '#' * int(30 * n / total) + '-' * (30 - int(30 * n / total))
                print(f'\r  [{bar}] {n}/{total}', end='', flush=True)
    print('\n  done.')


def teleport_sage(r):
    """Teleport Sage to the clearing inside the arena."""
    print('\n[2/3] Teleporting Sage...')
    result = r.cmd('/tp Sage 0 -59 20')
    print(f'  Sage: {result}')
    print('  done.')


def add_trees(r):
    """Add 16 more oak trees — fill in gaps around the clearing."""
    print('\n[3/3] Planting extra trees...')
    # New positions in the gaps between existing trees
    extra_trees = [
        (-43, 0), (43, 0), (0, -43), (0, 43),       # cardinal flanks (caves are at ±14, these are further)
        (-40, -20), (-40, 20), (40, -20), (40, 20),  # mid flanks
        (-28, -42), (28, -42), (-28, 42), (28, 42),  # outer diagonals
        (-46, -34), (46, -34), (-46, 34), (46, 34),  # corner ring
    ]
    for i, (tx, tz) in enumerate(extra_trees):
        x, z = CX + tx, CZ + tz
        # Trunk
        for dy in range(1, 6):
            r.setblock(x, SY + dy, z, 'minecraft:oak_log')
        # Lower canopy (Y+5 and Y+6)
        for lx in range(-2, 3):
            for lz in range(-2, 3):
                if abs(lx) == 2 and abs(lz) == 2:
                    continue
                r.setblock(x + lx, SY + 5, z + lz, 'minecraft:oak_leaves[persistent=true]')
                r.setblock(x + lx, SY + 6, z + lz, 'minecraft:oak_leaves[persistent=true]')
        # Upper canopy (Y+7)
        for lx in range(-1, 2):
            for lz in range(-1, 2):
                r.setblock(x + lx, SY + 7, z + lz, 'minecraft:oak_leaves[persistent=true]')
        # Top
        r.setblock(x, SY + 8, z, 'minecraft:oak_leaves[persistent=true]')
        bar = '#' * int(30 * (i+1) / len(extra_trees)) + '-' * (30 - int(30 * (i+1) / len(extra_trees)))
        print(f'\r  [{bar}] {i+1}/{len(extra_trees)}', end='', flush=True)
    print('\n  done.')


if __name__ == '__main__':
    print('=' * 60)
    print('  Arena Quickfix')
    print('  - Clear floating layer (Y=44-80)')
    print('  - Teleport Sage')
    print('  - +16 trees')
    print('=' * 60)
    r = RCON(RCON_HOST, RCON_PORT, RCON_PASS)
    try:
        clear_floating_layer(r)
        teleport_sage(r)
        add_trees(r)
    finally:
        r.close()
    print('\n' + '=' * 60)
    print('  Quickfix complete!')
    print('=' * 60)
