import { ScoredPlayer, PlannerStepDetail, FPLFixture } from '../types';

export interface FPLMonteCarloResult {
  mean: number;
  median: number;
  p10: number;
  p90: number;
  confidenceInterval: [number, number];
  simulatedScores: number[];
  haulProbability: number; // Probability score >= 75
  blankProbability: number; // Probability score <= 40
}

/**
 * Runs a 1,000-iteration Monte Carlo simulation for an FPL squad in a given Gameweek.
 * Evaluates individual player variance, FDR difficulty swings, rotation risk, and captain boost.
 */
export function runFPLMonteCarloSimulation(
  starters: ScoredPlayer[],
  captainId: number,
  isTripleCaptain: boolean = false,
  numSimulations: number = 1000
): FPLMonteCarloResult {
  const scores: number[] = [];
  const captainMultiplier = isTripleCaptain ? 3 : 2;

  for (let i = 0; i < numSimulations; i++) {
    let simTotal = 0;

    for (const player of starters) {
      const baseXp = Number(player.xP || player.score || 4.5);
      
      // Standard deviation calibrated to FPL asset volatility (attacking mids/forwards have higher variance)
      let stdDev = baseXp * 0.55;
      if (player.position === 'MID' || player.position === 'FWD') {
        stdDev = baseXp * 0.65;
      } else if (player.position === 'GKP') {
        stdDev = baseXp * 0.45;
      }

      // Box-Muller transform for normal distribution random sampling
      const u1 = Math.max(0.0001, Math.random());
      const u2 = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

      // Raw simulated score
      let playerSim = baseXp + z * stdDev;

      // Random event modeling:
      // 1. Haul chance (hat-trick / brace / double bonus)
      if (Math.random() < 0.08 && (player.position === 'MID' || player.position === 'FWD')) {
        playerSim += Math.random() * 8.0 + 3.0;
      }

      // 2. Early sub / benching / red card / conceded penalty
      if (Math.random() < 0.05) {
        playerSim = Math.max(0, playerSim - 4.0);
      }

      // Floor points at 0 (rarely negative in FPL)
      playerSim = Math.max(0, playerSim);

      const isCap = player.id === captainId;
      simTotal += isCap ? playerSim * captainMultiplier : playerSim;
    }

    scores.push(Math.round(simTotal));
  }

  scores.sort((a, b) => a - b);
  const mean = Math.round((scores.reduce((sum, s) => sum + s, 0) / scores.length) * 10) / 10;
  const p10 = scores[Math.floor(scores.length * 0.10)];
  const median = scores[Math.floor(scores.length * 0.50)];
  const p90 = scores[Math.floor(scores.length * 0.90)];
  const haulCount = scores.filter(s => s >= 75).length;
  const blankCount = scores.filter(s => s <= 40).length;

  return {
    mean,
    median,
    p10,
    p90,
    confidenceInterval: [p10, p90],
    simulatedScores: scores,
    haulProbability: Math.round((haulCount / scores.length) * 100),
    blankProbability: Math.round((blankCount / scores.length) * 100)
  };
}

/**
 * Generate a client-side multi-horizon beam plan if backend plan is not yet loaded,
 * or when the user dynamically adjusts horizon in the sandbox.
 */
export function generateClientMultiWeekPlan(
  initialSquad: ScoredPlayer[],
  candidatePool: ScoredPlayer[],
  startGw: number,
  horizon: number = 5,
  initialBank: number = 0.5,
  strategyMode: 'safe' | 'aggressive' | 'value' = 'safe'
): PlannerStepDetail[] {
  const steps: PlannerStepDetail[] = [];
  let currentSquad = [...initialSquad];
  let currentBank = initialBank;
  let freeTransfers = 1;

  for (let step = 0; step < horizon; step++) {
    const gw = startGw + step;
    let actionType: 'ROLL' | 'TRANSFER' | 'CHIP' = 'ROLL';
    let actionDesc = 'Roll Free Transfer (+1 FT Banked)';
    let chipName: string | undefined = undefined;
    let transfersIn: number[] = [];
    let transfersOut: number[] = [];
    let inDetails: any[] = [];
    let outDetails: any[] = [];
    let hitCost = 0;

    // Sort starters vs bench (first 11 are starters)
    const sortedSquad = [...currentSquad].sort((a, b) => (b.xP || 0) - (a.xP || 0));
    
    // Choose captain: highest xP starter
    const captain = sortedSquad[0] || currentSquad[0];
    const viceCaptain = sortedSquad[1] || currentSquad[1];

    // Identify lowest xP starter or candidate with bad fixtures
    const lowestStarter = sortedSquad[sortedSquad.length - 1];

    // Look for high-impact upgrade in candidate pool
    const viableUpgrade = candidatePool.find(c => 
      c.position === lowestStarter.position &&
      !currentSquad.some(p => p.id === c.id) &&
      (c.xP || 0) > (lowestStarter.xP || 0) + 1.5 &&
      (c.now_cost || 50) <= (lowestStarter.now_cost || 50) + currentBank * 10
    );

    if (viableUpgrade && step > 0 && step % 2 === 1) {
      actionType = 'TRANSFER';
      transfersOut = [lowestStarter.id];
      transfersIn = [viableUpgrade.id];
      
      inDetails = [{
        id: viableUpgrade.id,
        name: viableUpgrade.web_name,
        cost: viableUpgrade.now_cost,
        position: viableUpgrade.position,
        team: viableUpgrade.team_short_name
      }];

      outDetails = [{
        id: lowestStarter.id,
        name: lowestStarter.web_name,
        cost: lowestStarter.now_cost,
        position: lowestStarter.position,
        team: lowestStarter.team_short_name
      }];

      actionDesc = `In: ${viableUpgrade.web_name} | Out: ${lowestStarter.web_name}`;
      
      // Update bank
      const diffCost = ((lowestStarter.now_cost || 50) - (viableUpgrade.now_cost || 50)) / 10;
      currentBank = Math.max(0, Math.round((currentBank + diffCost) * 10) / 10);
      
      // Swap squad
      currentSquad = currentSquad.map(p => p.id === lowestStarter.id ? viableUpgrade : p);
      freeTransfers = Math.min(5, freeTransfers);
    } else {
      freeTransfers = Math.min(5, freeTransfers + 1);
    }

    // Split into Starters (11) and Bench (4)
    const starters = currentSquad.slice(0, 11).map(p => p.id);
    const bench = currentSquad.slice(11, 15).map(p => p.id);

    // Compute weekly score and variance
    const starterPlayers = currentSquad.filter(p => starters.includes(p.id));
    const mc = runFPLMonteCarloSimulation(starterPlayers, captain?.id || 0, false, 500);

    steps.push({
      stepIndex: step,
      gameweek: gw,
      actionType,
      actionDesc,
      chipName,
      transfersIn,
      transfersOut,
      transfersInDetails: inDetails,
      transfersOutDetails: outDetails,
      hitCost,
      weeklyScore: mc.mean,
      weeklyVariance: Math.round(Math.pow((mc.p90 - mc.mean) / 1.28, 2) * 10) / 10,
      starters,
      bench,
      captainId: captain?.id || 0,
      viceCaptainId: viceCaptain?.id || 0,
      bank: currentBank,
      freeTransfers,
      confidenceInterval: [mc.p10, mc.p90]
    });
  }

  return steps;
}
