#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) { throw new Error(message); }
function normalizedPrompt(value) { return value.replace(/\r\n?/g, '\n').trim(); }
function imageLeaf(item) {
  const leaf = path.basename(item.relativePath || item.name || '');
  if (!/^\d{6}-.+\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(leaf)) fail(`Invalid image filename for sequence ${item.sequence}`);
  return leaf;
}
function sourcePath(source, item) {
  const relative = String(item.relativePath || '').replace(/\\/g, '/');
  const firstSlash = relative.indexOf('/');
  return path.join(source, firstSlash >= 0 ? relative.slice(firstSlash + 1) : relative);
}
function cloneFile(source, target) {
  try { fs.linkSync(source, target); return 'hardlink'; }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error.code)) throw error;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    return 'clone-or-copy';
  }
}
function summarizeErrors(errors) {
  const counts = new Map();
  for (const error of errors) {
    const key = JSON.stringify({ code: error.code || 'prompt_unresolved' });
    if (!counts.has(key)) counts.set(key, { code: error.code || 'prompt_unresolved', affectedImages: 0, conversations: new Set() });
    const group = counts.get(key); group.affectedImages++;
    if (error.conversationId) group.conversations.add(error.conversationId);
  }
  return [...counts.values()].map(({ conversations, ...value }) => ({ ...value, affectedConversations: conversations.size }));
}

function canonicalIndex(report, folder) {
  return { kind: 'grid-canonical-index', layoutVersion: 2,
    groupingRuleVersion: 'legacy-first-occurrence-reconciled-v1', page: report.page, scope: report.scope,
    folder, imageCount: report.images.length,
    images: report.images.map(item => ({ sequence: item.sequence, fileId: item.fileId,
      name: item.name, relativePath: item.relativePath, status: 'available',
      groupName: item.groupName || null, promptStatus: item.promptStatus || 'disabled',
      promptError: item.promptStatus === 'unresolved' ? item.promptError || null : null,
      ...(Number.isFinite(item.bytes) ? { bytes: item.bytes } : {}),
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
      ...(typeof item.sha256 === 'string' ? { sha256: item.sha256 } : {}) })) };
}

function writeIndexFromReconciled(directory) {
  const reportPath = path.join(directory, 'chatgpt-images-reconciled-results.json');
  if (!fs.existsSync(reportPath)) fail('Missing chatgpt-images-reconciled-results.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const index = canonicalIndex(report, path.basename(directory));
  fs.writeFileSync(path.join(directory, 'grid-index.json'), JSON.stringify(index, null, 2) + '\n');
  return { folder: directory, imageCount: index.imageCount };
}

function buildPlan(source) {
  const reportPath = path.join(source, 'chatgpt-images-download-results.json');
  if (!fs.existsSync(reportPath)) fail('Missing chatgpt-images-download-results.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.schemaVersion !== 4 || !Array.isArray(report.images) || !report.images.length) fail('Unsupported result report');
  const promptsByOldGroup = new Map();
  for (const item of report.images) if (item.promptStatus === 'resolved') {
    const group = String(item.groupName || '');
    if (!/^\d+$/.test(group)) fail(`Unexpected legacy group ${group}`);
    if (!promptsByOldGroup.has(group)) {
      const promptPath = path.join(source, group, 'prompt.txt');
      if (!fs.existsSync(promptPath)) fail(`Missing ${group}/prompt.txt`);
      promptsByOldGroup.set(group, normalizedPrompt(fs.readFileSync(promptPath, 'utf8')));
    }
  }
  const sidecar = new Map();
  const unresolvedDir = path.join(source, '未解析');
  if (fs.existsSync(unresolvedDir)) for (const name of fs.readdirSync(unresolvedDir)) {
    const match = name.match(/^(\d{6})-prompt\.txt$/);
    if (match) sidecar.set(Number(match[1]), normalizedPrompt(fs.readFileSync(path.join(unresolvedDir, name), 'utf8')));
  }
  const byText = new Map(), groups = [], images = [];
  for (const item of [...report.images].sort((a, b) => a.sequence - b.sequence)) {
    if (item.sequence !== images.length + 1) fail('Image sequence is not complete and contiguous');
    const prompt = item.promptStatus === 'resolved' ? promptsByOldGroup.get(String(item.groupName)) : sidecar.get(item.sequence);
    let targetGroup = '未解析', groupNumber;
    if (prompt) {
      let group = byText.get(prompt);
      if (!group) {
        groupNumber = groups.length;
        group = { groupNumber, groupName: String(groupNumber).padStart(4, '0'), prompt, entries: [] };
        byText.set(prompt, group); groups.push(group);
      }
      targetGroup = group.groupName; groupNumber = group.groupNumber;
      group.entries.push(item.sequence);
    }
    const from = sourcePath(source, item);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) fail(`Missing image for sequence ${item.sequence}: ${from}`);
    images.push({ item, prompt: prompt || null, from, leaf: imageLeaf(item), targetGroup, groupNumber });
  }
  return { report, groups, images, unresolved: images.filter(image => !image.prompt).length,
    recovered: images.filter(image => image.item.promptStatus === 'unresolved' && image.prompt).length };
}

function execute(source, target) {
  const plan = buildPlan(source);
  if (fs.existsSync(target)) fail(`Target already exists: ${target}`);
  const temp = `${target}.building-${Date.now()}`;
  if (fs.existsSync(temp)) fail(`Temporary target already exists: ${temp}`);
  fs.mkdirSync(temp, { recursive: false });
  let hardlinks = 0, copies = 0, imageBytes = 0;
  for (const group of plan.groups) {
    const directory = path.join(temp, group.groupName);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'prompt.txt'), `${group.prompt}\n`, { flag: 'wx' });
  }
  if (plan.unresolved) fs.mkdirSync(path.join(temp, '未解析'));
  const targetName = path.basename(target);
  const reconciledImages = [];
  for (const image of plan.images) {
    const destination = path.join(temp, image.targetGroup, image.leaf);
    const method = cloneFile(image.from, destination);
    if (method === 'hardlink') hardlinks++; else copies++;
    const stat = fs.statSync(destination), sourceStat = fs.statSync(image.from);
    if (stat.size !== sourceStat.size) fail(`Size mismatch for sequence ${image.item.sequence}`);
    imageBytes += stat.size;
    reconciledImages.push({ ...image.item,
      sourceRelativePath: image.item.relativePath,
      relativePath: `${targetName}/${image.targetGroup}/${image.leaf}`,
      groupName: image.targetGroup,
      ...(image.prompt ? { groupNumber: image.groupNumber, promptStatus: 'resolved', promptError: null,
        warnings: (image.item.warnings || []).filter(value => !/提示词无法恢复/.test(value)) } :
        { groupNumber: undefined, promptStatus: 'unresolved' }),
      status: 'reconciled-local', downloadId: undefined });
  }
  for (const name of ['chatgpt-images-metadata.json']) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) cloneFile(from, path.join(temp, name));
  }
  const remainingIds = new Set(reconciledImages.filter(item => item.promptStatus === 'unresolved').map(item => item.fileId));
  const collectionErrors = (plan.report.prompts?.collectionErrors || []).filter(error => remainingIds.has(error.fileId));
  const reconciled = { ...plan.report,
    extensionVersion: 'legacy-reconciler-1', createdAt: new Date().toISOString(),
    layoutReconciledAt: new Date().toISOString(), sourceDirectory: source,
    groupCount: plan.groups.length, selectedGroupCount: plan.groups.length,
    queued: 0, failed: 0, warnings: reconciledImages.filter(item => item.warnings?.length).length,
    downloadStatusMeaning: 'reconciled-local means the original local image bytes were hard-linked or cloned into the canonical layout.',
    prompts: { ...plan.report.prompts, status: plan.unresolved ? 'partial' : 'resolved',
      groupCount: plan.groups.length, selectedGroupCount: plan.groups.length,
      collectionErrors, errorSummary: summarizeErrors(collectionErrors),
      unresolvedCount: plan.unresolved, selectedUnresolvedCount: plan.unresolved,
      resolvedImages: reconciledImages.length - plan.unresolved,
      groups: plan.groups.map(group => ({ groupNumber: group.groupNumber, groupName: group.groupName,
        firstSequence: group.entries[0], imageCount: group.entries.length, selectedCount: group.entries.length })) },
    images: reconciledImages,
    reconciliation: { source: source, recoveredPrompts: plan.recovered, unresolvedPrompts: plan.unresolved,
      imageCount: reconciledImages.length, imageBytes, hardlinks, copies } };
  fs.writeFileSync(path.join(temp, 'chatgpt-images-reconciled-results.json'), JSON.stringify(reconciled, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(temp, 'grid-index.json'), JSON.stringify(canonicalIndex(reconciled, targetName), null, 2) + '\n', { flag: 'wx' });
  const actualImages = fs.readdirSync(temp, { recursive: true }).filter(name => /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(name)).length;
  if (actualImages !== plan.images.length) fail(`Final image count mismatch: ${actualImages} != ${plan.images.length}`);
  fs.renameSync(temp, target);
  return reconciled.reconciliation;
}

const args = process.argv.slice(2);
const source = path.resolve(args.find(value => !value.startsWith('--')) || '');
if (!source || !fs.existsSync(source)) fail('Usage: reconcile-legacy-export.js <source> [--target <directory>] [--execute]');
if (args.includes('--write-index-only')) {
  console.log(JSON.stringify({ mode: 'index-written', ...writeIndexFromReconciled(source) }, null, 2));
  process.exit(0);
}
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? path.resolve(args[targetIndex + 1]) : `${source}-reconciled`;
const plan = buildPlan(source);
const summary = { source, target, images: plan.images.length, groups: plan.groups.length,
  recoveredPrompts: plan.recovered, unresolvedPrompts: plan.unresolved };
if (!args.includes('--execute')) console.log(JSON.stringify({ mode: 'dry-run', ...summary }, null, 2));
else console.log(JSON.stringify({ mode: 'executed', ...summary, ...execute(source, target) }, null, 2));
