// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

contract BlockchainSurveyor {
    struct LotRecord {
        uint256 id;
        string spatialHash;     // SHA-256 of coordinates
        string coordsJson;      // serialized coordinate points
        uint256 area;           // in square meters
        address owner;
        address surveyor;       // Geodetic surveyor address
        address LGU;            // Local government unit official address
        uint256 timestamp;
        bool isVerified;
    }

    address public admin;
    uint256 public lotCount;
    mapping(uint256 => LotRecord) public lots;
    mapping(string => bool) public spatialHashExists;
    
    // lotId => neighborAddress => hasSigned
    mapping(uint256 => mapping(address => bool)) public neighborApprovals;
    // lotId => list of neighbors required to sign
    mapping(uint256 => address[]) public requiredNeighbors;

    // Authorized Role whitelists
    mapping(address => bool) public authorizedSurveyors;
    mapping(address => bool) public authorizedLGUs;

    event LotRegistered(uint256 indexed id, string indexed spatialHash, address indexed owner, uint256 area);
    event BoundarySigned(uint256 indexed id, address indexed neighbor);
    event SurveyorVerified(uint256 indexed id, address indexed surveyor);
    event LGUApproved(uint256 indexed id, address indexed LGU);
    event RoleAuthorizationChanged(string role, address indexed account, bool status);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can call this");
        _;
    }

    modifier onlyAuthorizedSurveyor() {
        require(authorizedSurveyors[msg.sender], "Not an authorized Geodetic Surveyor");
        _;
    }

    modifier onlyAuthorizedLGU() {
        require(authorizedLGUs[msg.sender], "Not an authorized LGU official");
        _;
    }

    modifier onlyLotOwner(uint256 _id) {
        require(lots[_id].owner == msg.sender, "Only the lot owner can modify");
        _;
    }

    constructor() {
        admin = msg.sender;
        // Authorize deployer by default for easy local sandbox test setups
        authorizedSurveyors[msg.sender] = true;
        authorizedLGUs[msg.sender] = true;
    }

    // Role management
    function setSurveyorStatus(address _surveyor, bool _status) public onlyAdmin {
        authorizedSurveyors[_surveyor] = _status;
        emit RoleAuthorizationChanged("Surveyor", _surveyor, _status);
    }

    function setLGUStatus(address _lgu, bool _status) public onlyAdmin {
        authorizedLGUs[_lgu] = _status;
        emit RoleAuthorizationChanged("LGU", _lgu, _status);
    }

    // Register a new lot coordinate draft
    function registerLot(
        string memory _spatialHash,
        string memory _coordsJson,
        uint256 _area,
        address[] memory _neighbors
    ) public returns (uint256) {
        require(!spatialHashExists[_spatialHash], "Boundary coordinates already registered");
        
        lotCount++;
        lots[lotCount] = LotRecord({
            id: lotCount,
            spatialHash: _spatialHash,
            coordsJson: _coordsJson,
            area: _area,
            owner: msg.sender,
            surveyor: address(0),
            LGU: address(0),
            timestamp: block.timestamp,
            isVerified: false
        });

        spatialHashExists[_spatialHash] = true;
        requiredNeighbors[lotCount] = _neighbors;

        emit LotRegistered(lotCount, _spatialHash, msg.sender, _area);
        return lotCount;
    }

    // Neighbor consensus boundary signoff
    function signBoundary(uint256 _id) public {
        bool isRequired = false;
        address[] memory neighbors = requiredNeighbors[_id];
        for (uint256 i = 0; i < neighbors.length; i++) {
            if (neighbors[i] == msg.sender) {
                isRequired = true;
                break;
            }
        }
        require(isRequired, "You are not listed as a neighbor for this lot");
        require(!neighborApprovals[_id][msg.sender], "You have already signed this boundary");

        neighborApprovals[_id][msg.sender] = true;
        emit BoundarySigned(_id, msg.sender);

        _checkVerificationStatus(_id);
    }

    // Geodetic surveyor stamps the land record
    function verifySurveyor(uint256 _id) public onlyAuthorizedSurveyor {
        require(lots[_id].id != 0, "Lot does not exist");
        lots[_id].surveyor = msg.sender;
        emit SurveyorVerified(_id, msg.sender);
        _checkVerificationStatus(_id);
    }

    // Barangay/LGU official notarizes the land record
    function approveLGU(uint256 _id) public onlyAuthorizedLGU {
        require(lots[_id].id != 0, "Lot does not exist");
        lots[_id].LGU = msg.sender;
        emit LGUApproved(_id, msg.sender);
        _checkVerificationStatus(_id);
    }

    // Check if the Triple-Consensus is achieved (Neighbors + Surveyor + LGU)
    function _checkVerificationStatus(uint256 _id) internal {
        LotRecord storage record = lots[_id];
        if (record.surveyor == address(0) || record.LGU == address(0)) {
            return;
        }

        // Check if all required neighbors have signed
        address[] memory neighbors = requiredNeighbors[_id];
        for (uint256 i = 0; i < neighbors.length; i++) {
            if (!neighborApprovals[_id][neighbors[i]]) {
                return;
            }
        }

        record.isVerified = true;
    }

    // Active / archived tracking
    mapping(uint256 => bool) public isArchived;
    // Map child lot subdivision relationships
    mapping(uint256 => uint256[]) public lotChildren;

    event LotSubdivided(uint256 indexed parentId, uint256[] childIds);

    // Subdivide a verified parent lot into multiple child lots
    function subdivideLot(
        uint256 _parentId,
        string[] memory _childHashes,
        string[] memory _childCoordsJsons,
        uint256[] memory _childAreas,
        address[] memory _siblings
    ) public onlyLotOwner(_parentId) returns (uint256[] memory) {
        require(lots[_parentId].isVerified, "Parent lot must be fully verified and consensus sealed");
        require(!isArchived[_parentId], "Parent lot is already archived");
        require(_childHashes.length == _childAreas.length && _childHashes.length == _childCoordsJsons.length, "Invalid children input dimensions");

        isArchived[_parentId] = true;
        uint256[] memory childIds = new uint256[](_childHashes.length);

        for (uint256 i = 0; i < _childHashes.length; i++) {
            require(!spatialHashExists[_childHashes[i]], "Child boundary coordinates already registered");

            lotCount++;
            lots[lotCount] = LotRecord({
                id: lotCount,
                spatialHash: _childHashes[i],
                coordsJson: _childCoordsJsons[i],
                area: _childAreas[i],
                owner: msg.sender,
                surveyor: lots[_parentId].surveyor,
                LGU: lots[_parentId].LGU,
                timestamp: block.timestamp,
                isVerified: false 
            });

            spatialHashExists[_childHashes[i]] = true;
            requiredNeighbors[lotCount] = _siblings;
            childIds[i] = lotCount;
            lotChildren[_parentId].push(lotCount);

            emit LotRegistered(lotCount, _childHashes[i], msg.sender, _childAreas[i]);
        }

        emit LotSubdivided(_parentId, childIds);
        return childIds;
    }

    // Helper functions to fetch required neighbors
    function getRequiredNeighbors(uint256 _id) public view returns (address[] memory) {
        return requiredNeighbors[_id];
    }
}
