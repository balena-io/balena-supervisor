# Image management in the supervisor

The supervisor needs to keep a set of docker images on the device, striving to be atomic in its operations, to use minimal bandwidth when downloading, and to not use more disk space than necessary.

The image management in the supervisor was designed with these attributes in mind. Docker does not allow storing mutable metadata on images, so we don't have a way to keep fields like release ID or service ID on the actual docker images - this means we need to use the supervisor's sqlite database. To avoid issues with atomicity (e.g. if the device is powered off right after pulling an image), the process to pull a new image is as follows:

1) We store metadata about an image in the database
2) We start pulling the image (or downloading a delta)
3) Once the image has been pulled, we update the database with the image ID.

If the process is interrupted by a power outage at any point, we'll end up with either a dangling image (if we were pulling a v2 delta), or a dangling database entry (without a corresponding image being downloaded). This is why there's two cleanup operations: a) when the supervisor starts, it cleans any entries in the database that don't have a matching docker image; and b) on every run of the device state engine when there's no other image actions, it cleans up any dangling docker images.

A lot of the logic for image management is implemented in ApplicationManager's `_compareImages`. This function looks at current and target state and figures out which images to remove, by determining if:

1) They're not needed by any running containers
2) They're not needed by any container in the target state
3) They're not needed as the source image for a delta download, and
4) They're not needed by dependent applications.

When comparing images, we use digests to determine whether two images are the same. This avoids unnecessary downloads and restarts when a container hasn't changed in a new release. But in the database, we keep separate references for each imageId, serviceId, and appId - that way, we only *really* delete an image from docker when there's no more references to that sha256 docker image ID - this is implemented in `removeImageIfNotNeeded` in the Images class.
