import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { IMAGE } from "./versions.ts";

/**
 * A hostname the deployment should publish, and the workload answering it.
 * `service` is the name prefix: the Service is `<prefix>-service`.
 */
export type Route = { service: string; hostname: string };

export type Deployed = { routes: Route[] };

/**
 * The reader and every page of the comic, in one private image.
 *
 * The pages are baked in rather than mounted, so the pod has no node to be
 * pinned to and nothing to fetch at runtime. That makes the image the thing to
 * protect: it is pulled with a registry credential, and the site itself sits
 * behind a password.
 */
export function createTransmet(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: {
    hostname: string;
    /** The one password the site asks for. Rotating it signs every device out. */
    password: pulumi.Input<string>;
    /** Read access to ghcr.io, since the image holds the comic itself. */
    registry: { username: pulumi.Input<string>; token: pulumi.Input<string> };
    limits?: { cpu: string; memory: string };
    requests?: { cpu: string; memory: string };
    nodeSelector?: Record<string, string>;
  },
) {
  const options = { provider };
  const labels = { app: "transmet" };

  const secret = new k8s.core.v1.Secret(
    "transmet",
    {
      metadata: { name: "transmet", namespace },
      stringData: { password: opts.password },
    },
    options,
  );

  const pull = new k8s.core.v1.Secret(
    "transmet-pull",
    {
      metadata: { name: "transmet-pull", namespace },
      type: "kubernetes.io/dockerconfigjson",
      stringData: {
        ".dockerconfigjson": pulumi
          .all([opts.registry.username, opts.registry.token])
          .apply(([username, token]) =>
            JSON.stringify({
              auths: {
                "ghcr.io": {
                  auth: Buffer.from(`${username}:${token}`).toString("base64"),
                },
              },
            }),
          ),
      },
    },
    options,
  );

  new k8s.apps.v1.Deployment(
    "transmet",
    {
      metadata: { name: "transmet", namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // Restarts the pod when the password changes, which a Secret
            // referenced by env would otherwise leave stale until it next rolls.
            annotations: {
              "transmet.radiosilence.dev/password": pulumi
                .output(opts.password)
                .apply((p) => hash(p)),
            },
          },
          spec: {
            imagePullSecrets: [{ name: pull.metadata.name }],
            nodeSelector: opts.nodeSelector,
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "transmet",
                image: IMAGE,
                ports: [{ name: "http", containerPort: 3000 }],
                env: [
                  {
                    name: "TRANSMET_PASSWORD",
                    valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "password" } },
                  },
                ],
                readinessProbe: { httpGet: { path: "/_health", port: "http" }, periodSeconds: 10 },
                livenessProbe: {
                  httpGet: { path: "/_health", port: "http" },
                  initialDelaySeconds: 5,
                  periodSeconds: 30,
                },
                resources: {
                  limits: opts.limits ?? { cpu: "500m", memory: "256Mi" },
                  requests: opts.requests,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    },
    options,
  );

  // Named for what the ingress derives from the route prefix.
  new k8s.core.v1.Service(
    "transmet-service",
    {
      metadata: { name: "transmet-service", namespace },
      spec: { selector: labels, ports: [{ port: 80, targetPort: 3000 }] },
    },
    options,
  );

  // It serves files and reaches nothing, so all egress is denied. No ingress
  // rule: Traefik reaches it, and an ingress policy that also drops the
  // kubelet's probes gets the pod killed for failing readiness.
  new k8s.networking.v1.NetworkPolicy(
    "transmet-netpol",
    {
      metadata: { name: "transmet", namespace },
      spec: { podSelector: { matchLabels: labels }, policyTypes: ["Egress"], egress: [] },
    },
    options,
  );

  return { routes: [{ service: "transmet", hostname: opts.hostname }] } satisfies Deployed;
}

function hash(value: string) {
  let h = 0x811c9dc5;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16);
}
