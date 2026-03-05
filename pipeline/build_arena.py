#!/usr/bin/env python3
"""
Build a 100x100 AI learning arena on a fresh flat world.

Layout:
  - 100x100 arena, walls at ±50 from center (0,0)
  - Stone brick perimeter walls, 12 blocks high
  - Central hill (radius 14, 12 blocks tall, stone/dirt/grass)
  - 25-block radius flat clearing around the hill
  - 4 cave entrances at hill base, underground cross-shaped cave system
  - Coal and iron ore veins inside caves
  - Trees scattered 30-48 blocks from center
  - Pond east of clearing
  - Wheat/carrot crops near pond
  - Cows, pigs, sheep, chickens distributed in open sections
  - Spawn set south of hill in clearing
"""

import socket, struct, time, sys

RCON_HOST = '127.0.0.1'
RCON_PORT = 25575
RCON_PASS = 'ailab743915'

CX, CZ = 0, 0     # arena center
SY = -60           # surface Y for this flat config (bedrock@-64, 3x dirt, grass@-60)
AR = 50            # arena half-width (walls at ±50, arena is 100x100)

HILL_R  = 14       # hill base radius
CLEAR_R = 26       # flat clearing radius around center (beyond hill edge)
TREE_R_MIN = 30    # trees start here
TREE_R_MAX = 46    # trees end here


# ── RCON client ──────────────────────────────────────────────────────────────

class RCON:
    def __init__(self, host, port, password):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect((host, port))
        self._req = 1
        self._send(3, password)
        resp = self._recv()
        if struct.unpack('<i', resp[4:8])[0] == -1:
            raise Exception('RCON authentication failed — wrong password')
        print(f'  RCON authenticated.')

    def _send(self, ptype, body):
        data = body.encode('utf-8') + b'\x00\x00'
        packet = struct.pack('<III', 4 + 4 + len(data), self._req, ptype) + data
        self.sock.sendall(packet)

    def _recv(self):
        raw = b''
        while len(raw) < 4:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            raw += chunk
        length = struct.unpack('<I', raw[:4])[0]
        while len(raw) < 4 + length:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            raw += chunk
        return raw

    def cmd(self, command, delay=0.06):
        self._req += 1
        self._send(2, command)
        time.sleep(delay)
        try:
            resp = self._recv()
            return resp[12:-2].decode('utf-8', errors='ignore')
        except Exception:
            return ''

    def fill(self, x1, y1, z1, x2, y2, z2, block, mode=''):
        c = f'/fill {x1} {y1} {z1} {x2} {y2} {z2} {block}'
        if mode:
            c += f' replace'
        return self.cmd(c)

    def setblock(self, x, y, z, block):
        return self.cmd(f'/setblock {x} {y} {z} {block}')

    def summon(self, entity, x, z, nbt=''):
        c = f'/summon {entity} {x} {SY+1} {z}'
        if nbt:
            c += f' {nbt}'
        return self.cmd(c)

    def close(self):
        self.sock.close()


# ── helpers ───────────────────────────────────────────────────────────────────

def progress(label, current, total):
    bar = '#' * int(30 * current / total) + '-' * (30 - int(30 * current / total))
    print(f'\r  [{bar}] {current}/{total}  {label}', end='', flush=True)


def fill_disc(r, x1, y1, z1, x2, y2, z2, block, center_x=CX, center_z=CZ):
    """Fill a square box — Minecraft fill is always box-shaped so we use boxes per row."""
    r.fill(x1, y1, z1, x2, y2, z2, block)


# ── build phases ──────────────────────────────────────────────────────────────

def phase_ground(r):
    """Clear arena, add underground stone for caves, reset surface."""
    print('\n[1/10] Setting up ground...')

    # Clear everything in arena from Y=48 up to Y=120 (fresh slate)
    r.fill(CX-AR, 48, CZ-AR, CX+AR, 120, CZ+AR, 'minecraft:air')
    time.sleep(0.5)

    # Underground stone layer (Y=48–62) — gives cave tunnels material to cut through
    r.fill(CX-AR, 48, CZ-AR, CX+AR, 62, CZ+AR, 'minecraft:stone')
    time.sleep(0.3)

    # Dirt layer (Y=63)
    r.fill(CX-AR, 63, CZ-AR, CX+AR, 63, CZ+AR, 'minecraft:dirt')

    # Surface grass (Y=64)
    r.fill(CX-AR, SY, CZ-AR, CX+AR, SY, CZ+AR, 'minecraft:grass_block')

    print('  done.')


def phase_walls(r):
    """Stone brick perimeter walls, 12 blocks high."""
    print('\n[2/10] Building walls...')
    W = AR
    H = SY + 12   # top of wall

    # North wall (Z = -W)
    r.fill(CX-W, SY, CZ-W, CX+W, H, CZ-W, 'minecraft:stone_bricks')
    # South wall
    r.fill(CX-W, SY, CZ+W, CX+W, H, CZ+W, 'minecraft:stone_bricks')
    # West wall
    r.fill(CX-W, SY, CZ-W, CX-W, H, CZ+W, 'minecraft:stone_bricks')
    # East wall
    r.fill(CX+W, SY, CZ-W, CX+W, H, CZ+W, 'minecraft:stone_bricks')

    # Corner pillars (2 blocks thicker, 2 blocks taller) for visual polish
    for cx2, cz2 in [(-W, -W), (-W, W), (W, -W), (W, W)]:
        r.fill(CX+cx2-1, SY, CZ+cz2-1, CX+cx2+1, H+2, CZ+cz2+1, 'minecraft:chiseled_stone_bricks')

    print('  done.')


def phase_hill(r):
    """Build the central hill — dirt/stone core, grass cap."""
    print('\n[3/10] Building central hill...')

    # Hill layers from base up — each Y gets a smaller radius square
    layers = [
        (SY,    14, 'minecraft:dirt'),
        (SY+1,  13, 'minecraft:dirt'),
        (SY+2,  12, 'minecraft:dirt'),
        (SY+3,  10, 'minecraft:dirt'),
        (SY+4,   9, 'minecraft:stone'),
        (SY+5,   8, 'minecraft:stone'),
        (SY+6,   7, 'minecraft:stone'),
        (SY+7,   6, 'minecraft:stone'),
        (SY+8,   5, 'minecraft:stone'),
        (SY+9,   4, 'minecraft:dirt'),
        (SY+10,  3, 'minecraft:dirt'),
        (SY+11,  2, 'minecraft:dirt'),
        (SY+12,  1, 'minecraft:grass_block'),
    ]
    for y, radius, block in layers:
        r.fill(CX-radius, y, CZ-radius, CX+radius, y, CZ+radius, block)

    # Grass on lower slopes
    r.fill(CX-14, SY, CZ-14, CX+14, SY, CZ+14, 'minecraft:grass_block')

    print('  done.')


def phase_clearing(r):
    """Ensure the clearing (25-block radius) is flat clean grass."""
    print('\n[4/10] Flattening clearing...')
    # Remove anything sticking up in the clearing (above Y=64)
    r.fill(CX-CLEAR_R, SY+1, CZ-CLEAR_R, CX+CLEAR_R, SY+15, CZ+CLEAR_R, 'minecraft:air')
    # Re-grass the clearing floor (the hill fill may have covered some)
    r.fill(CX-CLEAR_R, SY, CZ-CLEAR_R, CX+CLEAR_R, SY, CZ+CLEAR_R, 'minecraft:grass_block')
    # But leave hill blocks (don't flatten the hill itself)
    print('  done.')


def phase_caves(r):
    """Carve 4 cave entrances and a cross-shaped underground system."""
    print('\n[5/10] Carving caves...')

    # Stone around arena underground is at Y=48–62
    # Cave tunnels: 3 wide, 3 tall, going from hill base outward

    # ── North cave
    r.fill(CX-2, 55, CZ-35, CX+2, 60, CZ-14, 'minecraft:air')   # entrance tunnel
    r.fill(CX-2, 52, CZ-48, CX+2, 57, CZ-35, 'minecraft:air')   # deeper section
    # ore veins
    r.setblock(CX-3, 57, CZ-38, 'minecraft:coal_ore')
    r.setblock(CX+3, 56, CZ-40, 'minecraft:coal_ore')
    r.setblock(CX-3, 54, CZ-43, 'minecraft:iron_ore')
    r.setblock(CX+3, 53, CZ-46, 'minecraft:iron_ore')
    r.setblock(CX, 52, CZ-42, 'minecraft:coal_ore')

    # ── South cave
    r.fill(CX-2, 55, CZ+14, CX+2, 60, CZ+35, 'minecraft:air')
    r.fill(CX-2, 52, CZ+35, CX+2, 57, CZ+48, 'minecraft:air')
    r.setblock(CX-3, 57, CZ+38, 'minecraft:coal_ore')
    r.setblock(CX+3, 56, CZ+40, 'minecraft:coal_ore')
    r.setblock(CX-3, 54, CZ+43, 'minecraft:iron_ore')
    r.setblock(CX, 52, CZ+42, 'minecraft:coal_ore')

    # ── West cave
    r.fill(CX-35, 55, CZ-2, CX-14, 60, CZ+2, 'minecraft:air')
    r.fill(CX-48, 52, CZ-2, CX-35, 57, CZ+2, 'minecraft:air')
    r.setblock(CX-38, 57, CZ-3, 'minecraft:coal_ore')
    r.setblock(CX-40, 56, CZ+3, 'minecraft:coal_ore')
    r.setblock(CX-43, 54, CZ-3, 'minecraft:iron_ore')
    r.setblock(CX-46, 53, CZ, 'minecraft:iron_ore')

    # ── East cave
    r.fill(CX+14, 55, CZ-2, CX+35, 60, CZ+2, 'minecraft:air')
    r.fill(CX+35, 52, CZ-2, CX+48, 57, CZ+2, 'minecraft:air')
    r.setblock(CX+38, 57, CZ-3, 'minecraft:coal_ore')
    r.setblock(CX+40, 56, CZ+3, 'minecraft:coal_ore')
    r.setblock(CX+43, 54, CZ-3, 'minecraft:iron_ore')
    r.setblock(CX+46, 53, CZ, 'minecraft:iron_ore')

    # ── Central chamber where all 4 caves meet (under the hill)
    r.fill(CX-4, 52, CZ-4, CX+4, 60, CZ+4, 'minecraft:air')
    r.setblock(CX, 55, CZ, 'minecraft:glowstone')    # lighting in cave center
    r.setblock(CX+4, 55, CZ+4, 'minecraft:glowstone')
    r.setblock(CX-4, 55, CZ-4, 'minecraft:glowstone')

    # Cave entrance markers (visible at hill base — gravel lip)
    for dx, dz in [(0,-14), (0,14), (-14,0), (14,0)]:
        r.fill(CX+dx-1, SY, CZ+dz-1, CX+dx+1, SY, CZ+dz+1, 'minecraft:gravel')

    print('  done.')


def phase_trees(r):
    """Place oak trees in a ring between TREE_R_MIN and TREE_R_MAX."""
    print('\n[6/10] Planting trees...')

    # Tree positions — ring around clearing, avoiding caves (cardinal axes)
    trees = [
        (-38, -38), (-38, 38), (38, -38), (38, 38),   # corners
        (-44, -10), (-44, 10), (44, -10), (44, 10),   # east/west flanks
        (-10, -44), (10, -44), (-10, 44), (10, 44),   # north/south flanks
        (-32, -32), (32, 32), (-32, 32), (32, -32),   # inner ring
    ]

    for i, (tx, tz) in enumerate(trees):
        progress('trees', i+1, len(trees))
        x, z = CX+tx, CZ+tz
        # Trunk (5 tall)
        for dy in range(1, 6):
            r.setblock(x, SY+dy, z, 'minecraft:oak_log')
        # Lower canopy (2x ring at Y+5 and Y+6)
        for lx in range(-2, 3):
            for lz in range(-2, 3):
                if abs(lx) == 2 and abs(lz) == 2:
                    continue  # skip corners
                r.setblock(x+lx, SY+5, z+lz, 'minecraft:oak_leaves[persistent=true]')
                r.setblock(x+lx, SY+6, z+lz, 'minecraft:oak_leaves[persistent=true]')
        # Upper canopy (Y+7)
        for lx in range(-1, 2):
            for lz in range(-1, 2):
                r.setblock(x+lx, SY+7, z+lz, 'minecraft:oak_leaves[persistent=true]')
        # Top
        r.setblock(x, SY+8, z, 'minecraft:oak_leaves[persistent=true]')

    print()
    print('  done.')


def phase_water_and_crops(r):
    """Add a small pond and crops east of the clearing."""
    print('\n[7/10] Adding pond and crops...')

    # Pond at ~(38, 0) — east side, just outside clearing
    r.fill(CX+30, SY-1, CZ-4, CX+38, SY-1, CZ+4, 'minecraft:dirt')
    r.fill(CX+30, SY,   CZ-4, CX+38, SY,   CZ+4, 'minecraft:air')
    r.fill(CX+30, SY-1, CZ-4, CX+38, SY-1, CZ+4, 'minecraft:water')

    # Dirt/sand shore
    r.fill(CX+29, SY, CZ-5, CX+39, SY, CZ+5, 'minecraft:sand')
    r.fill(CX+29, SY, CZ-4, CX+38, SY, CZ+4, 'minecraft:air')  # above water is air

    # Wheat and carrot patches north of pond
    for fx in range(CX+29, CX+38):
        r.setblock(fx, SY-1, CZ-6, 'minecraft:farmland')
        r.setblock(fx, SY-1, CZ-7, 'minecraft:farmland')
        if fx % 2 == 0:
            r.setblock(fx, SY, CZ-6, 'minecraft:wheat[age=7]')
            r.setblock(fx, SY, CZ-7, 'minecraft:carrots[age=7]')
        else:
            r.setblock(fx, SY, CZ-6, 'minecraft:carrots[age=7]')
            r.setblock(fx, SY, CZ-7, 'minecraft:potatoes[age=7]')

    print('  done.')


def phase_animals(r):
    """Spawn animals in each quadrant of the arena."""
    print('\n[8/10] Spawning animals...')

    animals = [
        # Cows — NW quadrant
        ('minecraft:cow', -38, -20),
        ('minecraft:cow', -35, -24),
        ('minecraft:cow', -40, -30),
        # Cows — SE quadrant
        ('minecraft:cow', 35, 25),
        ('minecraft:cow', 38, 20),
        # Pigs — SW quadrant
        ('minecraft:pig', -35, 25),
        ('minecraft:pig', -38, 30),
        ('minecraft:pig', -42, 22),
        # Pigs — NE
        ('minecraft:pig', 40, -30),
        ('minecraft:pig', 38, -25),
        # Sheep — spread around
        ('minecraft:sheep', -20, -40),
        ('minecraft:sheep', -24, -38),
        ('minecraft:sheep', 20, -40),
        ('minecraft:sheep', 24, -38),
        ('minecraft:sheep', -20, 40),
        ('minecraft:sheep', 20, 40),
        # Chickens — near pond and south
        ('minecraft:chicken', 32, 5),
        ('minecraft:chicken', 35, 8),
        ('minecraft:chicken', 30, -20),
        ('minecraft:chicken', -30, 20),
        ('minecraft:chicken', -28, 35),
        ('minecraft:chicken', -32, 38),
    ]

    for i, (mob, x, z) in enumerate(animals):
        progress('animals', i+1, len(animals))
        r.summon(mob, CX+x, CZ+z)

    print()
    print('  done.')


def phase_polish(r):
    """Flowers, gravel paths, lighting, spawn point."""
    print('\n[9/10] Final polish...')

    # Scatter flowers in clearing
    flowers = [
        (10, 5, 'minecraft:dandelion'),
        (-10, 8, 'minecraft:poppy'),
        (15, -10, 'minecraft:blue_orchid'),
        (-15, 10, 'minecraft:allium'),
        (8, 20, 'minecraft:dandelion'),
        (-8, -20, 'minecraft:poppy'),
        (20, 15, 'minecraft:cornflower'),
        (-20, -15, 'minecraft:oxeye_daisy'),
        (5, -18, 'minecraft:dandelion'),
        (-5, 18, 'minecraft:cornflower'),
    ]
    for fx, fz, flower in flowers:
        r.setblock(CX+fx, SY+1, CZ+fz, flower)

    # Torches on walls (for visibility at night)
    for offset in [-40, -20, 0, 20, 40]:
        r.setblock(CX-AR+1, SY+8, CZ+offset, 'minecraft:torch')
        r.setblock(CX+AR-1, SY+8, CZ+offset, 'minecraft:torch')
        r.setblock(CX+offset, SY+8, CZ-AR+1, 'minecraft:torch')
        r.setblock(CX+offset, SY+8, CZ+AR-1, 'minecraft:torch')

    # Set spawn in clearing, south of hill
    r.cmd(f'/setworldspawn {CX} {SY+1} {CZ+20}')

    # Game rules for stable arena
    r.cmd('/gamerule doDaylightCycle false')
    r.cmd('/gamerule doWeatherCycle false')
    r.cmd('/gamerule mobGriefing false')       # mobs can't destroy blocks
    r.cmd('/gamerule naturalRegeneration true')
    r.cmd('/time set 6000')   # noon
    r.cmd('/weather clear 999999')

    print('  done.')


def phase_teleport_agents(r):
    """Teleport all agents to the spawn point inside the arena."""
    print('\n[10/10] Teleporting agents...')
    positions = [
        ('Rook',  CX,    SY+1, CZ+15),
        ('Vex',   CX+5,  SY+1, CZ+15),
        ('Drift', CX-5,  SY+1, CZ+15),
        ('Echo',  CX+10, SY+1, CZ+15),
        ('Sage',  CX-10, SY+1, CZ+15),
    ]
    for name, x, y, z in positions:
        result = r.cmd(f'/tp {name} {x} {y} {z}')
        print(f'  {name}: {result.strip() or "ok"}')
    print('  done.')


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    print('=' * 60)
    print('  Minecraft AI Arena Builder')
    print('  100x100 walled arena with hill, caves, animals')
    print('=' * 60)

    try:
        r = RCON(RCON_HOST, RCON_PORT, RCON_PASS)
    except Exception as e:
        print(f'\nERROR: Could not connect to RCON — {e}')
        print('Is the Minecraft server running? Is RCON enabled on port 25575?')
        sys.exit(1)

    try:
        phase_ground(r)
        phase_walls(r)
        phase_hill(r)
        phase_clearing(r)
        phase_caves(r)
        phase_trees(r)
        phase_water_and_crops(r)
        phase_animals(r)
        phase_polish(r)
        phase_teleport_agents(r)
    except KeyboardInterrupt:
        print('\n\nBuild interrupted.')
    finally:
        r.close()

    print('\n' + '=' * 60)
    print('  Arena build complete!')
    print(f'  Center: {CX},{SY+1},{CZ}  |  Walls: ±{AR} blocks')
    print(f'  Hill: radius {HILL_R}, height 12  |  Clearing: radius {CLEAR_R}')
    print('  4 caves, 16 trees, 22 animals, pond + crops')
    print('=' * 60)


if __name__ == '__main__':
    main()
