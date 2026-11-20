/* global describe it */

const should = require('should');
const health = require('../lib/g7rig/health');

// /proc/meminfo of a Pi Zero W collector (Raspberry Pi OS 13), trimmed.
const MEMINFO = `MemTotal:         437312 kB
MemFree:          120344 kB
MemAvailable:     262292 kB
Buffers:           10424 kB
Cached:           160100 kB
SwapCached:            0 kB
Active:           101236 kB
Shmem:              1716 kB
SwapTotal:        218652 kB
SwapFree:         200000 kB
Zswap:                 0 kB
HugePages_Total:       0
CmaTotal:          65536 kB
CmaFree:           60140 kB
`;

const MOUNTS = `/dev/mmcblk0p2 /media/root-ro ext4 ro,relatime 0 0
tmpfs-root /media/root-rw tmpfs rw,relatime 0 0
overlayroot / overlay rw,relatime,lowerdir=/media/root-ro,upperdir=/media/root-rw/overlay,workdir=/media/root-rw/overlay-workdir/_ 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
/dev/mmcblk0p1 /boot/firmware vfat ro,relatime 0 0
`;

describe('g7-rig status health (lib/g7rig/health)', () => {
  it('load1 is the first field of /proc/loadavg', () => {
    health.load1('0.93 0.71 0.55 1/123 4567\n').should.equal(0.93);
    health.load1('12.00 3.00 1.00 2/99 1\n').should.equal(12);
    should(health.load1('')).be.null();
    should(health.load1(null)).be.null();
    should(health.load1('garbage')).be.null();
  });

  it('memory and swap from /proc/meminfo, in kB (swap used = SwapTotal - SwapFree)', () => {
    health.memory(MEMINFO).should.eql({
      mem_total_kb: 437312,
      mem_available_kb: 262292,
      swap_total_kb: 218652,
      swap_used_kb: 18652,
    });
  });

  it('no swap configured: zero total and zero used', () => {
    const text = MEMINFO.replace('218652', '0').replace('200000', '0');
    health.memory(text).should.containEql({ swap_total_kb: 0, swap_used_kb: 0 });
  });

  it('each memory field is null when its line is missing or unreadable', () => {
    health.memory(null).should.eql({
      mem_total_kb: null, mem_available_kb: null, swap_total_kb: null, swap_used_kb: null,
    });
    health.memory('MemTotal: 437312 kB\nSwapTotal: 1024 kB\n').should.eql({
      mem_total_kb: 437312, mem_available_kb: null, swap_total_kb: 1024, swap_used_kb: null,
    });
  });

  it('throttled is the hex value vcgencmd get_throttled prints', () => {
    health.throttled('throttled=0x0\n').should.equal('0x0');
    health.throttled('throttled=0x50005\n').should.equal('0x50005');
    should(health.throttled('')).be.null();
    should(health.throttled(null)).be.null();
    should(health.throttled('VCHI initialization failed\n')).be.null();
  });

  it('isMounted finds the RAM overlay in /proc/mounts, only as a mount point', () => {
    health.isMounted(MOUNTS, '/media/root-rw').should.equal(true);
    health.isMounted('/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n', '/media/root-rw').should.equal(false);
    health.isMounted(null, '/media/root-rw').should.equal(false);
  });

  it('overlay used/total in kB from a statfs result (used = blocks - bfree)', () => {
    health.overlay({ bsize: 4096, blocks: 54784, bfree: 54374 })
      .should.eql({ overlay_used_kb: 1640, overlay_total_kb: 219136 });
    health.overlay(null).should.eql({ overlay_used_kb: null, overlay_total_kb: null });
    health.overlay({ bsize: 4096 }).should.eql({ overlay_used_kb: null, overlay_total_kb: null });
  });

  it('build gives exactly the contract fields, in this order', () => {
    const h = health.build({
      loadavgText: '0.93 0.71 0.55 1/123 4567\n',
      meminfoText: MEMINFO.replace('218652', '0').replace('200000', '0'),
      overlayStatfs: { bsize: 4096, blocks: 54784, bfree: 54374 },
      throttledText: 'throttled=0x0\n',
    });
    JSON.stringify(h).should.equal(JSON.stringify({
      load1: 0.93,
      mem_total_kb: 437312,
      mem_available_kb: 262292,
      swap_total_kb: 0,
      swap_used_kb: 0,
      overlay_used_kb: 1640,
      overlay_total_kb: 219136,
      throttled: '0x0',
    }));
  });

  it('build with nothing readable: every field null', () => {
    health.build({}).should.eql({
      load1: null,
      mem_total_kb: null,
      mem_available_kb: null,
      swap_total_kb: null,
      swap_used_kb: null,
      overlay_used_kb: null,
      overlay_total_kb: null,
      throttled: null,
    });
  });
});
