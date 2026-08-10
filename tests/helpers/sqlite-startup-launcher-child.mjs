const [modulePath, rawInput] = process.argv.slice(2);
if (!modulePath || !rawInput) process.exit(2);

const { SqliteAgyStartupLauncher, SqliteStartupCapacityError } = await import(modulePath);
const input = JSON.parse(rawInput);
const launcher = new SqliteAgyStartupLauncher({
  databasePath: input.databasePath,
  ownerInstanceId: input.ownerInstanceId,
  now: () => 1_000,
  createPermitId: () => input.permitId
});

try {
  launcher.acquire("auxiliary");
  process.stdout.write(JSON.stringify({ status: "acquired" }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: error instanceof SqliteStartupCapacityError ? "capacity" : "error"
  }));
} finally {
  launcher.close();
}
