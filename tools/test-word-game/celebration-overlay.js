class CelebrationOverlay extends MotionSurface {
  constructor(host, manager) { super(host); this.manager = manager; this.active = false; }
  clear() { super.clear(); this.active = false; }
  show(winner) {
    this.clear(); this.active = true; this.startedAt = performance.now();
    const stage = document.createElement('div'); stage.className = 'celebration-scene';
    stage.innerHTML = '<div class="celebration-glow"></div><div class="celebration-burst"></div><div class="celebration-particles"></div>';
    const colors = ['#ffc857', '#ff8daf', '#ffab69', '#aa90ff', '#90ddff'];
    const burst = stage.querySelector('.celebration-burst');
    for (let i = 0; i < 24; i++) {
      const beam = document.createElement('i'); beam.className = 'celebration-beam';
      const angle = i * 15 + Math.random() * 9, length = 620 + Math.random() * 620;
      Object.assign(beam.style, { width: `${25 + Math.random() * 75}px`, height: `${length}px`, background: `linear-gradient(transparent, ${colors[i % 5]}ee)`, transform: `rotate(${angle}deg)`, opacity: .6 + Math.random() * .3 }); burst.append(beam);
    }
    const particles = stage.querySelector('.celebration-particles');
    for (let i = 0; i < 28; i++) {
      const p = document.createElement('i'); p.className = `celebration-particle particle-${i % 3}`;
      p.style.backgroundColor = colors[i % 5]; particles.append(p);
      const angle = Math.PI * 2 * i / 28, distance = 350 + Math.random() * 620;
      const x = Math.cos(angle) * distance, y = Math.sin(angle) * distance;
      this.move(p, [{ transform: 'translate(0,0) rotate(0) scale(.3)', opacity: 0 }, { opacity: 1, offset: .08 }, { transform: `translate(${x}px,${y}px) rotate(${i * 71}deg) scale(1)`, opacity: .95, offset: .75 }, { transform: `translate(${x * 1.1}px,${y + 180}px) rotate(${i * 97}deg) scale(.7)`, opacity: 0 }], { duration: 3200, easing: 'cubic-bezier(.15,.7,.35,1)', fill: 'both' });
    }
    const hero = document.createElement('div'); hero.className = 'celebration-hero';
    const reward = Number(winner.pendingReward ?? winner.scoreDelta);
    hero.innerHTML = `<span>全场猜中</span><strong>${escapeHtml(winner.word || '')}</strong><div>${avatarHtml(winner)}<b>${escapeHtml(actorName(winner))}</b><em>${reward > 0 ? `+${reward}` : '奖励结算中'}</em></div>`;
    hero.querySelector('strong').classList.toggle('long-answer', Array.from(winner.word || '').length > 5);
    stage.append(hero); this.host.append(stage);
    const rebound = [{ transform: 'translateY(20px) scale(.72)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1, offset: .43 }, { transform: 'scale(.98)', offset: .72 }, { transform: 'scale(1)', opacity: 1 }];
    this.move(hero, rebound, { duration: 420, easing: 'ease-out' });
    this.move(hero.querySelector('em'), [{ transform: 'scale(.8)' }, { transform: 'scale(1.24)', offset: .5 }, { transform: 'scale(1)' }], { duration: 620, delay: 280 });
    this.move(burst, [{ transform: 'scale(.08) rotate(-8deg)', opacity: 0 }, { transform: 'scale(1) rotate(0deg)', opacity: .9, offset: .12 }, { transform: 'scale(1.06) rotate(8deg)', opacity: .65, offset: .85 }, { transform: 'scale(1.08) rotate(10deg)', opacity: 0 }], { duration: 3200, easing: 'ease-out', fill: 'both' });
    this.later(() => { this.clear(); this.manager.drain(); }, 3200);
  }
}
